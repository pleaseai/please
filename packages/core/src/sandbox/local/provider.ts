/**
 * A host-process backend for the sandbox contract.
 *
 * The sibling of `../docker`, and its opposite trade. Docker buys isolation with a daemon, an
 * image pull and a container per sandbox id; this buys a start-up cost of nothing with no
 * isolation at all. It exists for the cases where that is the better trade — a test suite that
 * must run where no daemon does, a laptop working on the repository it is already inside, CI
 * without a docker-in-docker rig — and for the one thing a container cannot do, which is let a
 * command see the host it was launched from.
 *
 * Modelled on flue's `local()` (`packages/runtime/src/node/local-env.ts`) and on eve's local
 * bindings, whose `sessions/<key>` directory per session is the same answer `./root.ts` gives
 * to what a sandbox id names. What those two do not have to answer, and this does, is the
 * contract's process surface: `getProcess(id)` and `logs({ replay: true })` are read after a
 * process exits and frequently by a host process that did not start it, so commands are
 * journalled to disk rather than held as child handles — see `./journal.ts`.
 *
 * **This backend does not isolate anything, and nothing in it pretends otherwise.** A command
 * runs as the caller's own user with the caller's own filesystem and network. What it does
 * provide is a *default* that is not the host's: a working directory of its own, and an
 * environment allowlisted down from `process.env` so the agent's `bash` tool does not inherit
 * every credential the developer is carrying (`./env.ts`).
 */
import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '../contract'
import type { LocalEnvOptions } from './env'
import type { RootOptions } from './root'
import { resolveBaseEnv } from './env'
import { createSandboxRoot } from './root'
import { createLocalSession } from './session'

export interface LocalSandboxOptions extends LocalEnvOptions, Pick<RootOptions, 'root'> {
  /** Prefix for sandbox directory names, so several projects can share one root. */
  namePrefix?: string
}

/**
 * The loopback host every sandbox's ports are reached on.
 *
 * A port inside a local sandbox *is* a host port — there is nothing to publish and no address
 * to look up, which is the one place this backend is simpler than Docker's rather than more
 * complicated. It is also the one place it is weaker: containers get an ephemeral host port
 * each, so two Docker sandboxes can both serve 8080, while two local sandboxes on one machine
 * cannot. A caller running more than one at a time gives them different ports.
 */
const LOOPBACK = '127.0.0.1'

export function createLocalSandbox(options: LocalSandboxOptions): SandboxProvider {
  // Resolved once, not per session: the allowlist snapshot is what every process in every
  // sandbox from this provider sees, and re-reading `process.env` per call would let a host
  // mutation change what two runs of the same command inherit.
  //
  // Note what is *not* in it. The Docker backend declares `IS_SANDBOX=1` for every container,
  // because the Claude Code CLI refuses `bypassPermissions` as root without it and a container
  // genuinely is a deliberate sandbox. Here the claim would be false, and the check it defeats
  // is the one thing standing between a bypassed permission prompt and a developer's own home
  // directory. A caller that has arranged real confinement by other means can still set it in
  // `env`; this backend will not assert it on their behalf.
  const env = resolveBaseEnv(options.env)

  const roots = new Map<string, ReturnType<typeof createSandboxRoot>>()

  // Cached per sandbox id: `session()` is called per use rather than held across a workflow
  // step, and a fresh root each time would defeat the lazy acquisition behind it.
  const rootFor = (sandboxId: string) => {
    const existing = roots.get(sandboxId)
    if (existing !== undefined) {
      return existing
    }
    const created = createSandboxRoot(sandboxId, {
      root: options.root,
      ...(options.namePrefix === undefined ? {} : { prefix: options.namePrefix }),
    })
    roots.set(sandboxId, created)
    return created
  }

  const portEndpoint = async (
    _sandboxId: string,
    port: number,
    endpointOptions?: SandboxPortEndpointOptions,
  ): Promise<SandboxPortEndpoint> => {
    const protocol = endpointOptions?.protocol ?? 'http'
    return { url: `${protocol}://${LOOPBACK}:${port}` }
  }

  // `destroy()` deletes the directory, so the cached root is spent — keeping it would make a
  // long-lived provider grow by one dead entry per sandbox it ever tore down. The identity
  // check is what stops a teardown racing a re-`session()` from evicting the replacement.
  const session = (sandboxId: string): SandboxSession => {
    const root = rootFor(sandboxId)
    const created = createLocalSession({ root, env })
    return {
      ...created,
      destroy: async () => {
        try {
          await created.destroy()
        }
        finally {
          if (roots.get(sandboxId) === root) {
            roots.delete(sandboxId)
          }
        }
      },
    }
  }

  return {
    backend: 'local',
    session,
    portEndpoint,
  } satisfies SandboxProvider
}
