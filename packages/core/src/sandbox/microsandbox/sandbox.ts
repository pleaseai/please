/**
 * One microVM per sandbox id, created on first use.
 *
 * `SandboxProvider.session` is synchronous and cheap by contract, so nothing is created when a
 * session is resolved — the sandbox is acquired lazily, on the first call that actually needs it.
 * The acquisition is memoised, but **a failed one is not**: a rejected promise left in the latch
 * would be replayed by every later call without ever reaching the runtime again, so one transient
 * failure would make the sandbox permanently unusable. Same rule as `../docker/container.ts` and
 * `../local/root.ts`, for the same reason.
 *
 * **Adoption is what makes a sandbox id resumable across host processes.** The vendor keeps a
 * database of sandboxes by name, so a second process asking for the same id connects to the one
 * already running instead of colliding with it — which is also what lets a journal written by one
 * process be read by another. `Sandbox.get(name)` is the lookup; it rejects for a name the
 * database has never seen, and that rejection is the "nothing here" answer rather than an error
 * to propagate.
 */
import type { MicroSandbox, MicroSandboxBuilder } from './runtime'
import { createHash } from 'node:crypto'
import { loadMicrosandbox } from './runtime'

/** Characters the vendor's sandbox names are restricted to here. */
function sanitize(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '-')
}

/**
 * A short, stable digest of a string, as lowercase hex.
 *
 * SHA-256, truncated to 64 bits — the same choice and the same reasoning as `../local/root.ts`.
 * A collision here means two sandbox ids naming one microVM, so one id's `destroy()` kills the
 * other's machine and its journal with it. 32 bits reaches even odds of that at around 77,000
 * ids; 64 bits puts the same point past five billion. `createHash` is synchronous, so the
 * argument for a non-cryptographic hash — avoiding an `await` on web crypto — does not apply.
 */
function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * Sandbox name for a sandbox id, within what the runtime accepts.
 *
 * The same construction as `containerName` in `../docker/container.ts`, and for the same
 * reasons: the sanitiser is lossy, so a digest over the *raw* prefix and the *raw* id is
 * appended — both halves are an isolation boundary, and two prefixes that sanitize alike would
 * otherwise share every sandbox between them.
 *
 * The vendor documents a limit of 128 UTF-8 bytes on a name, so the sanitized id is truncated to
 * leave room for the prefix and digest. Truncation is lossy too, which is exactly what the
 * digest — computed before it — is there to carry.
 */
export function sandboxName(sandboxId: string, prefix = 'please'): string {
  const safePrefix = sanitize(prefix).replace(/^[^a-z0-9]+/i, '').slice(0, 32) || 'please'
  const digest = shortDigest(JSON.stringify([prefix, sandboxId]))
  const room = 128 - safePrefix.length - digest.length - 2
  return `${safePrefix}-${sanitize(sandboxId).slice(0, Math.max(1, room))}-${digest}`
}

export interface MicroVmOptions {
  /**
   * OCI image the sandbox runs. It must provide a POSIX `sh`, `setsid`, `tail`, `kill` and a
   * readable `/proc` — the journal in `../docker/journal.ts` is written in terms of all five.
   */
  image: string
  /** Working directory the sandbox starts in, and what relative commands resolve against. */
  workDir: string
  /** Ports to publish, as `guest → host`. Both sides are explicit; the runtime maps no port. */
  ports: ReadonlyMap<number, number>
  /** Environment baked into the sandbox at creation time. */
  env?: Readonly<Record<string, string>>
  /** vCPUs. Unset leaves the runtime's own default. */
  cpus?: number
  /** Memory in MiB. Unset leaves the runtime's own default. */
  memoryMib?: number
  /**
   * Anything else the vendor's builder accepts — network policy, volumes, rlimits, snapshots.
   *
   * Deliberately an escape hatch rather than a re-declaration of the vendor's surface, for the
   * reason `./runtime.ts` gives: copying those setters here would make this package's API drift
   * against a dependency it does not own.
   */
  configure?: (builder: MicroSandboxBuilder) => MicroSandboxBuilder
}

/** Apply this backend's own settings, then hand the builder to the caller's `configure`. */
function build(builder: MicroSandboxBuilder, options: MicroVmOptions): MicroSandboxBuilder {
  builder.image(options.image).workdir(options.workDir)
  if (options.cpus !== undefined) {
    builder.cpus(options.cpus)
  }
  if (options.memoryMib !== undefined) {
    builder.memory(options.memoryMib)
  }
  if (options.env !== undefined) {
    builder.envs({ ...options.env })
  }
  for (const [guest, host] of options.ports) {
    builder.port(host, guest)
  }
  // The label is what marks a sandbox as this backend's, for anyone reading the runtime's own
  // listing. It is set last so a caller's `configure` can still override it.
  builder.labels({ 'ai.please.backend': 'microsandbox' })
  return options.configure === undefined ? builder : options.configure(builder)
}

/** Connect to the sandbox this id already has, or `undefined` if it has none. */
async function adopt(name: string): Promise<MicroSandbox | undefined> {
  const { Sandbox } = await loadMicrosandbox()
  try {
    const handle = await Sandbox.get(name)
    return await handle.connect()
  }
  catch {
    // Either the name is unknown or the sandbox is not answering. Both mean there is nothing to
    // adopt; the caller creates instead, and a real failure surfaces from that attempt with the
    // runtime's own message rather than one invented here.
    return undefined
  }
}

/**
 * Resolve the sandbox for a name, adopting a running one before creating a new one.
 *
 * A create that loses the race to another process is retried as an adoption once — beyond that
 * the original failure is the honest answer, because a name that is neither creatable nor
 * adoptable is not a transient state this can wait out.
 */
async function acquire(name: string, options: MicroVmOptions): Promise<MicroSandbox> {
  const adopted = await adopt(name)
  if (adopted !== undefined) {
    return adopted
  }
  const { Sandbox } = await loadMicrosandbox()
  try {
    return await build(Sandbox.builder(name), options).create()
  }
  catch (cause) {
    const raced = await adopt(name)
    if (raced !== undefined) {
      return raced
    }
    throw cause
  }
}

export interface MicroVmHandle {
  readonly name: string
  /** Resolve the sandbox, creating it on first call. */
  readonly ready: () => Promise<MicroSandbox>
  /**
   * The sandbox if one already exists for this id, without creating anything.
   *
   * Discovery calls — `getProcess`, `listProcesses` — use this so that probing a sandbox that
   * was never started answers "nothing here" instead of standing one up as a side effect of the
   * question. Unlike `ready()`, this does adopt: a sandbox another process created for the same
   * id is a sandbox that exists, and its journals are the answer being asked for.
   */
  readonly peek: () => Promise<MicroSandbox | undefined>
  /** Destroy the sandbox and everything on it. Idempotent. */
  readonly remove: () => Promise<void>
}

export function createMicroVmHandle(
  sandboxId: string,
  options: MicroVmOptions & { prefix?: string },
): MicroVmHandle {
  const name = sandboxName(sandboxId, options.prefix)
  let acquisition: Promise<MicroSandbox> | undefined

  const ready = (): Promise<MicroSandbox> => (acquisition ??= acquire(name, options).catch(
    (cause: unknown) => {
      acquisition = undefined
      throw cause
    },
  ))

  return {
    name,
    ready,
    peek: async () => (acquisition === undefined ? adopt(name) : ready()),
    remove: async () => {
      acquisition = undefined
      const { Sandbox } = await loadMicrosandbox()
      let handle
      try {
        handle = await Sandbox.get(name)
      }
      catch {
        // A sandbox that was never there is the state `remove` promises.
        return
      }
      // Killed before removed: the runtime refuses to remove a sandbox that is still running,
      // and a `remove` that resolved without doing either would leak a microVM silently.
      await handle.kill().catch(() => undefined)
      await handle.remove()
    },
  }
}
