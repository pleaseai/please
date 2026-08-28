/**
 * A virtual-shell backend for the sandbox contract, over `just-bash`.
 *
 * The third of three, and the one that runs no processes at all: `just-bash` is a bash
 * interpreter written in TypeScript over an in-memory filesystem, so a command here is parsed
 * and evaluated rather than executed. Nothing is installed, nothing is spawned, and nothing
 * survives the host process.
 *
 * That buys the one thing the other two cannot offer together — it runs anywhere, instantly,
 * with the sandboxed filesystem genuinely separate from the host's. `../local` has real binaries
 * but no separation; `../docker` has both but needs a daemon and an image pull.
 *
 * **Three limits are structural, not gaps to be filled later.** Each is measured, and each is a
 * reason to choose a different backend rather than something this one can grow:
 *
 * - **No real binaries.** `git --version` exits 127 `command not found`. The command set is the
 *   interpreter's own, so a turn that runs a package manager, a compiler or `git` cannot run
 *   here at all.
 * - **No ports.** There is no listener to reach, so {@link JustBashPortsUnavailableError} is
 *   what `portEndpoint` answers — see the note on that class for why it throws rather than
 *   inventing a URL.
 * - **No live output.** The interpreter buffers a command's output and delivers it on
 *   completion, so `logs({ follow: true })` returns everything at the end rather than as it
 *   happens. See `./process.ts`.
 */
import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '../contract'
import type { ProcessRecord } from './process'
import type { JustBashHandle } from './sandbox'
import { createJustBashHandle } from './sandbox'
import { createJustBashSession } from './session'

/**
 * Raised by `portEndpoint`, which this backend cannot answer.
 *
 * The contract requires `portEndpoint` rather than making it optional, and says why: "a backend
 * that cannot say where its ports are cannot run the harness at all, and finding that out at the
 * first connect — inside a workflow step — is strictly worse than finding it out at build time."
 * This class is that sentence at run time. The alternative — answering `http://127.0.0.1:<port>`
 * — would hand back a URL that dials the *host*, which is both wrong and dangerous: a caller
 * would connect to whatever happens to be listening there.
 *
 * So a bridge-backed harness adapter cannot use this backend, and learns it from a named error
 * naming the reason. `../docker/provider.ts` already records the same fact from the other side.
 */
export class JustBashPortsUnavailableError extends Error {
  readonly port: number

  constructor(port: number) {
    super(
      `the just-bash backend cannot expose port ${port}: its commands are interpreted, not `
      + 'executed, so nothing in the sandbox ever listens on a socket. Use the docker or local '
      + 'backend for a harness adapter that needs a port.',
    )
    this.name = 'JustBashPortsUnavailableError'
    this.port = port
  }
}

/** Working directory a sandbox starts in when the caller names none. */
export const DEFAULT_WORK_DIR = '/work'

export interface JustBashSandboxOptions {
  /** Working directory inside the virtual filesystem. Defaults to {@link DEFAULT_WORK_DIR}. */
  workDir?: string
  /** Environment every command starts with. Nothing is inherited from the host. */
  env?: Readonly<Record<string, string>>
  /**
   * Passed through to `just-bash`. Defaults to whether the runtime supports it — it is broken
   * under Bun, measured; see `./runtime.ts`.
   */
  defenseInDepth?: boolean
  /**
   * Anything else `just-bash`'s own `SandboxOptions` accepts — `network`, `python`,
   * `javascript`, `commands`, `customCommands`, `overlayRoot` — passed through untouched.
   *
   * Deliberately an escape hatch rather than a re-declaration of the vendor's options. Copying
   * them here would make this package's surface drift against a dependency it does not own, and
   * every one of them is a `just-bash` concept with no meaning to the other backends.
   */
  vendorOptions?: Readonly<Record<string, unknown>>
}

export function createJustBashSandbox(options: JustBashSandboxOptions = {}): SandboxProvider {
  const handles = new Map<string, JustBashHandle>()
  // Beside the handle rather than inside the session, because `session()` is called per use: a
  // registry created per session object would lose every process the previous call started.
  const registries = new Map<string, Map<string, ProcessRecord>>()

  // Cached per sandbox id: `session()` is called per use rather than held, and a fresh handle
  // each time would defeat the lazy acquisition behind it — and, here, would silently hand back
  // an empty filesystem to the second caller.
  const handleFor = (sandboxId: string): JustBashHandle => {
    const existing = handles.get(sandboxId)
    if (existing !== undefined) {
      return existing
    }
    const created = createJustBashHandle({
      cwd: options.workDir ?? DEFAULT_WORK_DIR,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.defenseInDepth === undefined ? {} : { defenseInDepth: options.defenseInDepth }),
      ...(options.vendorOptions === undefined ? {} : { vendorOptions: options.vendorOptions }),
    })
    handles.set(sandboxId, created)
    return created
  }

  const registryFor = (sandboxId: string): Map<string, ProcessRecord> => {
    const existing = registries.get(sandboxId)
    if (existing !== undefined) {
      return existing
    }
    const created = new Map<string, ProcessRecord>()
    registries.set(sandboxId, created)
    return created
  }

  const portEndpoint = async (
    _sandboxId: string,
    port: number,
    _endpointOptions?: SandboxPortEndpointOptions,
  ): Promise<SandboxPortEndpoint> => {
    throw new JustBashPortsUnavailableError(port)
  }

  const session = (sandboxId: string): SandboxSession => {
    const handle = handleFor(sandboxId)
    const created = createJustBashSession({ handle, processes: registryFor(sandboxId) })
    return {
      ...created,
      destroy: async () => {
        // Evicted before the teardown is awaited, not in a `finally` after it. Awaiting first
        // leaves a window in which a new `session(id)` finds this handle still registered,
        // adopts it, and reacquires — and the identity check would then still pass, so this
        // call would delete the *new* session's handle and its process registry on the way
        // out. Removing the entry up front makes the next `session(id)` build a fresh handle
        // instead of one that is being torn down.
        if (handles.get(sandboxId) === handle) {
          handles.delete(sandboxId)
          registries.delete(sandboxId)
        }
        await created.destroy()
      },
    }
  }

  return {
    backend: 'just-bash',
    session,
    portEndpoint,
  } satisfies SandboxProvider
}
