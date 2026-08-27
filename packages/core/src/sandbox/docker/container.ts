/**
 * One container per sandbox id, created on first use.
 *
 * `SandboxProvider.session` is synchronous and cheap by contract, so nothing is created when
 * a session is resolved — the container is acquired lazily, on the first call that actually
 * needs it, where the caller's own abort signal applies.
 *
 * The acquisition is memoised, but **a failed one is not**. A rejected promise left in the
 * latch would be replayed by every later call without ever reaching the daemon again, so one
 * transient failure would make the sandbox permanently unusable. That is the same rule
 * `session.ts` follows for teardown, and for the same reason.
 */
import { DockerCommandError, runDocker, runDockerOrThrow } from './cli'

/** Characters `docker run --name` accepts after the first one. */
function sanitize(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '-')
}

/**
 * A short, stable digest of a string, as lowercase hex.
 *
 * FNV-1a: the digest only has to separate two ids the sanitizer maps together, so a
 * non-cryptographic hash that needs no async subtle-crypto call is the right size of tool.
 */
function shortDigest(value: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Container name for a sandbox id, constrained to what the daemon accepts.
 *
 * The sanitiser is lossy — `a/b` and `a:b` both flatten to `a-b` — so a digest is appended.
 * It covers the *raw* prefix and the *raw* id together, because both halves are lossy and
 * both are an isolation boundary: an id separates sandboxes, and `namePrefix` separates
 * projects sharing one daemon. Two prefixes that sanitize alike would otherwise share every
 * container between them. The sanitized parts stay readable and the digest carries the
 * difference. The prefix additionally loses any leading non-alphanumeric, because Docker
 * requires a name to start with one.
 */
export function containerName(sandboxId: string, prefix = 'please'): string {
  const safePrefix = sanitize(prefix).replace(/^[^a-z0-9]+/i, '') || 'please'
  // NUL cannot occur in either half, so the pair cannot be re-split into a different pair.
  return `${safePrefix}-${sanitize(sandboxId)}-${shortDigest(`${prefix}\u0000${sandboxId}`)}`
}

export interface ContainerOptions {
  /** Image the sandbox runs. It must provide node >= 22, pnpm, `setsid`, and a POSIX `sh`. */
  image: string
  /** Working directory the container starts in, and what relative commands resolve against. */
  workDir: string
  /** Ports to publish. Each is bound to an ephemeral port on the loopback interface. */
  ports: readonly number[]
  /** Environment baked into the container at creation time. */
  env?: Readonly<Record<string, string>>
  /** Container user. Unset uses the image's own `USER`. */
  user?: string
  /**
   * Commands run once, in order, immediately after the container is created.
   *
   * This is the only hook that lands *before* a harness adapter's own bootstrap: the framework
   * passes that bootstrap in as `onFirstCreate`, so anything the recipe depends on — `pnpm` on
   * the official node images, for instance, which ships only through corepack — has to be in
   * place by the time the container is handed over. A container adopted rather than created
   * does not re-run them.
   */
  setupCommands?: readonly string[]
}

function createArgs(name: string, options: ContainerOptions): string[] {
  const args = ['run', '--detach', '--name', name, '--workdir', options.workDir]
  if (options.user !== undefined) {
    args.push('--user', options.user)
  }
  for (const port of options.ports) {
    args.push('--publish', `127.0.0.1::${port}`)
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`)
  }
  // `sleep infinity` rather than the image's own entrypoint: the container is a place to run
  // `docker exec` against, and an entrypoint that exits would take the sandbox with it.
  // `--entrypoint` rather than a trailing command, because an image that declares one would
  // otherwise receive `sleep infinity` as arguments to it instead of in place of it.
  args.push('--entrypoint', 'sleep', options.image, 'infinity')
  return args
}

/**
 * Marker inside the container saying its setup started and has not finished.
 *
 * Removal after a failed setup can itself fail — a daemon hiccup, a container the runtime
 * refuses to reap — and adoption does not re-run setup, so the next acquisition would hand
 * back a half-built sandbox that looks complete. The marker is what survives that: it lives
 * on the container's own filesystem, so whoever adopts it can see the setup never finished.
 */
const SETUP_MARKER = '/tmp/.please-setup-incomplete'

/** Run the caller's one-time setup, failing loudly rather than leaving a half-built image. */
async function runSetup(name: string, commands: readonly string[]): Promise<void> {
  for (const command of commands) {
    const result = await runDocker(['exec', name, 'sh', '-c', command])
    if (result.exitCode !== 0) {
      throw new Error(
        `setup command failed in '${name}' (exit ${result.exitCode}): ${command}\n${result.stderr.trim()}`,
      )
    }
  }
}

/**
 * Run setup under the marker, and take the container away if it fails.
 *
 * Removal failure is reported rather than swallowed, and is survivable either way: the
 * marker is still on the container, so a later adoption re-runs setup instead of trusting it.
 */
async function performSetup(name: string, commands: readonly string[]): Promise<void> {
  if (commands.length === 0) {
    return
  }
  await runDockerOrThrow(['exec', name, 'sh', '-c', `: > ${SETUP_MARKER}`])
  try {
    await runSetup(name, commands)
  }
  catch (cause) {
    const removal = await runDocker(['rm', '--force', '--volumes', name])
    if (removal.exitCode !== 0 && !/no such container/i.test(removal.stderr)) {
      throw new Error(
        `setup failed in '${name}' and the container could not be removed `
        + `(exit ${removal.exitCode}): ${removal.stderr.trim()}`,
        { cause },
      )
    }
    throw cause
  }
  await runDockerOrThrow(['exec', name, 'sh', '-c', `rm -f ${SETUP_MARKER}`])
}

/** Re-run setup on an adopted container whose own setup never finished. */
async function completeInterruptedSetup(name: string, commands: readonly string[]): Promise<void> {
  if (commands.length === 0) {
    return
  }
  const probe = await runDocker(['exec', name, 'test', '-e', SETUP_MARKER])
  if (probe.exitCode === 0) {
    await performSetup(name, commands)
  }
}

/** The container's state as the daemon reports it, or undefined when there is none. */
async function containerStatus(name: string): Promise<string | undefined> {
  const result = await runDocker(['container', 'inspect', '--format', '{{.State.Status}}', name])
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

/**
 * Take over a container that already exists, or report that it is no longer there.
 *
 * `undefined` means the name vanished between the inspect and the start — another process
 * removed it, or a create that appeared to conflict had already been torn down. The caller
 * creates fresh in that case. Answering it is the whole point of this return type: starting
 * a name that does not exist fails with `No such container` every time it is retried, so a
 * single lost race would make the sandbox permanently unusable rather than merely late.
 *
 * `docker start` on an already-running container succeeds, so skipping it for `running` is
 * not a correctness fix — it is one fewer daemon round trip on the path every resume takes.
 */
async function adopt(
  name: string,
  status: string,
  setup: readonly string[],
): Promise<string | undefined> {
  if (status !== 'running') {
    const started = await runDocker(['start', name])
    if (started.exitCode !== 0) {
      if (/no such container/i.test(started.stderr)) {
        return undefined
      }
      throw new DockerCommandError(['start', name], started.exitCode, started.stderr)
    }
  }
  await completeInterruptedSetup(name, setup)
  return name
}

/**
 * Create the container, or adopt one that already carries this name.
 *
 * Adoption is what makes a sandbox id resumable across processes: a second process asking
 * for the same id finds the running container instead of colliding with it. A container
 * found stopped is restarted rather than recreated, so its filesystem — and every journal on
 * it — survives.
 *
 * Every path through here ends in a usable container or a thrown error — never in a state
 * that only fails. A create that is interrupted partway (a pull killed by a test timeout, a
 * cancelled command) leaves nothing to adopt, and the next `ready()` must be free to create
 * from scratch rather than keep starting a name the daemon has never heard of.
 */
async function acquire(name: string, options: ContainerOptions): Promise<string> {
  const setup = options.setupCommands ?? []
  const existing = await containerStatus(name)
  if (existing !== undefined) {
    const adopted = await adopt(name, existing, setup)
    if (adopted !== undefined) {
      return adopted
    }
  }
  try {
    await runDockerOrThrow(createArgs(name, options))
  }
  catch (cause) {
    // Lost a race with another process creating the same id: adopt what it made — unless it
    // is already gone again, which leaves the original failure as the honest answer.
    if (cause instanceof DockerCommandError && cause.stderr.includes('already in use')) {
      const raced = await containerStatus(name)
      const adopted = raced === undefined ? undefined : await adopt(name, raced, setup)
      if (adopted !== undefined) {
        return adopted
      }
    }
    throw cause
  }
  // A container whose setup failed is a half-built sandbox that no later `ready()` would
  // ever finish on its own, so `performSetup` takes it away and marks it if it cannot.
  await performSetup(name, setup)
  return name
}

export interface ContainerHandle {
  readonly name: string
  /** Resolve the container, creating it on first call. */
  readonly ready: () => Promise<string>
  /** Host address an exposed container port is reachable at, as `host:port`. */
  readonly hostAddress: (port: number) => Promise<string>
  /** Remove the container and everything on it. Idempotent. */
  readonly remove: () => Promise<void>
  /**
   * The container name if it is already running, without creating or starting anything.
   *
   * Discovery calls — `getProcess`, `listProcesses` — use this so that probing a sandbox
   * that was never started answers "nothing here" instead of standing one up as a side
   * effect of the question.
   */
  readonly peek: () => Promise<string | undefined>
}

export function createContainerHandle(
  sandboxId: string,
  options: ContainerOptions & { prefix?: string },
): ContainerHandle {
  const name = containerName(sandboxId, options.prefix)
  let acquisition: Promise<string> | undefined

  const ready = (): Promise<string> => (acquisition ??= acquire(name, options).catch(
    (cause: unknown) => {
      acquisition = undefined
      throw cause
    },
  ))

  return {
    name,
    ready,
    hostAddress: async (port) => {
      await ready()
      const mapping = await runDockerOrThrow(['port', name, String(port)])
      const line = mapping.split('\n').map(entry => entry.trim()).find(entry => entry.length > 0)
      if (line === undefined) {
        throw new Error(`container '${name}' publishes no host address for port ${port}`)
      }
      // `docker port` answers `0.0.0.0:54321` or `[::]:54321`; both mean the loopback here,
      // and a literal `0.0.0.0` is not a dialable address on every platform.
      const separator = line.lastIndexOf(':')
      return `127.0.0.1:${line.slice(separator + 1)}`
    },
    remove: async () => {
      acquisition = undefined
      const result = await runDocker(['rm', '--force', '--volumes', name])
      // A container that was never there is the state `remove` promises, so that one result
      // is success. Anything else leaked a container, and a silent resolve would hide it.
      if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
        throw new DockerCommandError(['rm', '--force', '--volumes', name], result.exitCode, result.stderr)
      }
    },
    peek: async () => (await containerStatus(name) === 'running' ? name : undefined),
  }
}
