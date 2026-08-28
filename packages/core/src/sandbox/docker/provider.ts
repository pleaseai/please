/**
 * A local Docker backend for the sandbox contract.
 *
 * Written because the AI SDK ships no container provider — `@ai-sdk/sandbox-just-bash` cannot
 * expose a port, which every bridge-backed harness adapter needs, and `@ai-sdk/sandbox-vercel`
 * is a remote service. Implementing the contract rather than `HarnessV1SandboxProvider`
 * directly means `../harness` supplies the harness view for free, the same as it does for
 * every other backend.
 */
import type { SandboxPortEndpoint, SandboxPortEndpointOptions, SandboxProvider } from '../contract'
import type { ContainerOptions } from './container'
import { createContainerHandle } from './container'
import { createDockerSession } from './session'

export interface DockerSandboxOptions extends ContainerOptions {
  /** Prefix for container names, so several projects can share one daemon. */
  namePrefix?: string
}

/**
 * The image a sandbox needs when it runs the Claude Code adapter.
 *
 * The adapter bootstraps itself inside the sandbox — `pnpm install --frozen-lockfile` then
 * `claude --version` — so the image must carry node >= 22 and pnpm and be able to reach the
 * registry. `setsid` and GNU `tail` are required by the process journal.
 */
export const DEFAULT_IMAGE = 'node:22-bookworm'

/**
 * What every container declares about itself, before the caller's own environment.
 *
 * `IS_SANDBOX=1` is the Claude Code CLI's own way of being told it is running inside a
 * deliberate sandbox, and for this backend the claim is simply true. It is not a convenience:
 * the adapter's *default* permission mode — `allow-all` with every built-in tool active —
 * reaches the Agent SDK as `bypassPermissions`, and the CLI refuses that outright when it is
 * root. Its gate is `getuid() === 0 && IS_SANDBOX !== '1' && !CLAUDE_CODE_BUBBLEWRAP`, and
 * {@link DEFAULT_IMAGE} runs as root, so without this the adapter cannot start a turn here at
 * all — it dies with `--dangerously-skip-permissions cannot be used with root/sudo
 * privileges`. Measured by `scripts/probe-permissions.ts`.
 *
 * The caller wins. Passing `IS_SANDBOX` in `env` overrides it, because a caller that sets a
 * non-root `user` does not need it and should be able to say so.
 */
export function containerEnv(env: ContainerOptions['env']): Record<string, string> {
  return { IS_SANDBOX: '1', ...env }
}

export function createDockerSandbox(options: DockerSandboxOptions): SandboxProvider {
  const handles = new Map<string, ReturnType<typeof createContainerHandle>>()

  // Cached per sandbox id: `session()` is called per use rather than held across a workflow
  // step, and a fresh handle each time would defeat the lazy acquisition behind it.
  const handleFor = (sandboxId: string) => {
    const existing = handles.get(sandboxId)
    if (existing !== undefined) {
      return existing
    }
    const created = createContainerHandle(sandboxId, {
      ...options,
      env: containerEnv(options.env),
      ...(options.namePrefix === undefined ? {} : { prefix: options.namePrefix }),
    })
    handles.set(sandboxId, created)
    return created
  }

  const portEndpoint = async (
    sandboxId: string,
    port: number,
    endpointOptions?: SandboxPortEndpointOptions,
  ): Promise<SandboxPortEndpoint> => {
    const address = await handleFor(sandboxId).hostAddress(port)
    const protocol = endpointOptions?.protocol ?? 'http'
    return { url: `${protocol}://${address}` }
  }

  // `destroy()` removes the container, so the cached handle is spent — keeping it would make
  // a long-lived provider grow by one dead entry per sandbox it ever tore down. The identity
  // check is what stops a teardown racing a re-`session()` from evicting the replacement.
  const session = (sandboxId: string) => {
    const handle = handleFor(sandboxId)
    const created = createDockerSession({ container: handle })
    return {
      ...created,
      destroy: async () => {
        try {
          await created.destroy()
        }
        finally {
          if (handles.get(sandboxId) === handle) {
            handles.delete(sandboxId)
          }
        }
      },
    }
  }

  return {
    backend: 'docker',
    session,
    portEndpoint,
  } satisfies SandboxProvider
}
