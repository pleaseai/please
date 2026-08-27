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

/** Container name for a sandbox id, constrained to what the daemon accepts. */
export function containerName(sandboxId: string, prefix = 'please'): string {
  const safe = sandboxId.replaceAll(/[^\w.-]/g, '-')
  return `${prefix}-${safe}`
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
  args.push(options.image, 'sleep', 'infinity')
  return args
}

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

/** Whether a container with this name exists, in any state. */
async function containerExists(name: string): Promise<boolean> {
  const result = await runDocker(['container', 'inspect', '--format', '{{.State.Status}}', name])
  return result.exitCode === 0
}

/**
 * Create the container, or adopt one that already carries this name.
 *
 * Adoption is what makes a sandbox id resumable across processes: a second process asking
 * for the same id finds the running container instead of colliding with it. A container
 * found stopped is restarted rather than recreated, so its filesystem — and every journal on
 * it — survives.
 */
async function acquire(name: string, options: ContainerOptions): Promise<string> {
  if (await containerExists(name)) {
    await runDockerOrThrow(['start', name])
    return name
  }
  try {
    await runDockerOrThrow(createArgs(name, options))
  }
  catch (cause) {
    // Lost a race with another process creating the same id: adopt what it made.
    if (cause instanceof DockerCommandError && cause.stderr.includes('already in use')) {
      await runDockerOrThrow(['start', name])
      return name
    }
    throw cause
  }
  await runSetup(name, options.setupCommands ?? [])
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
      await runDocker(['rm', '--force', '--volumes', name])
    },
  }
}
