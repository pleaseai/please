/**
 * A microVM backend for the sandbox contract, over `microsandbox`.
 *
 * The fourth backend, and the only one whose isolation is a hypervisor rather than a namespace or
 * an interpreter: each sandbox is a real kernel in a VM, booted from an OCI image. That is what
 * it is for — `../docker` shares the host kernel, and a container escape is a host compromise.
 *
 * It also costs the most to reach. `microsandbox` ships a native addon per platform and needs a
 * hypervisor underneath it, so it is an **optional peer dependency** loaded dynamically and
 * absent on some hosts entirely — see {@link MicrosandboxUnavailableError} and the verification
 * note on `./runtime.ts`.
 *
 * **Ports are declared, never discovered.** The runtime maps a guest port to a host port only
 * when the sandbox is built with that mapping, so `portEndpoint` answers from the map the caller
 * supplied and raises {@link MicrosandboxPortNotMappedError} for anything else — rather than
 * returning `http://127.0.0.1:<port>`, which would dial whatever is listening on the *host*.
 */
import type { SandboxPortEndpoint, SandboxPortEndpointOptions, SandboxProvider, SandboxSession } from '../contract'
import type { MicroVmHandle, MicroVmOptions } from './sandbox'
import { createMicroVmHandle } from './sandbox'
import { createMicrosandboxSession } from './session'

/**
 * Raised when `portEndpoint` is asked for a port the sandbox was not built to publish.
 *
 * A guest port with no mapping is not reachable from the host at all, so there is no URL to
 * return. Answering one anyway would send the caller to a host-local service that has nothing to
 * do with the sandbox — the same trap `../just-bash/provider.ts` refuses for the same reason,
 * except that here it is fixable: add the port to {@link MicrosandboxSandboxOptions.ports} before
 * the sandbox is created.
 */
export class MicrosandboxPortNotMappedError extends Error {
  readonly port: number

  constructor(port: number, mapped: readonly number[]) {
    super(
      `guest port ${port} is not published by this sandbox`
      + `${mapped.length === 0 ? ' (none are)' : ` (published: ${mapped.join(', ')})`}`
      + '. A microVM publishes only the ports it was created with, so add it to the `ports` '
      + 'option — a port cannot be mapped after the sandbox is running.',
    )
    this.name = 'MicrosandboxPortNotMappedError'
    this.port = port
  }
}

/**
 * The image a sandbox needs when it runs the Claude Code adapter.
 *
 * The same requirement `../docker/provider.ts` records: the adapter bootstraps itself inside the
 * sandbox, so the image must carry node >= 22 and pnpm and be able to reach the registry. The
 * process journal additionally needs `setsid`, GNU `tail`, `kill` and a readable `/proc`.
 */
export const DEFAULT_IMAGE = 'node:22-bookworm'

/** Working directory a sandbox starts in when the caller names none. */
export const DEFAULT_WORK_DIR = '/work'

/**
 * What every sandbox declares about itself, before the caller's own environment.
 *
 * `IS_SANDBOX=1` is the Claude Code CLI's own way of being told it is running inside a deliberate
 * sandbox, and here the claim is true with more room to spare than anywhere else: this is a
 * separate kernel. The reason it matters is the one `../docker/provider.ts` measured — the
 * adapter's default permission mode reaches the Agent SDK as `bypassPermissions`, and the CLI
 * refuses that outright as root unless `IS_SANDBOX` says otherwise.
 *
 * The caller wins: passing `IS_SANDBOX` in `env` overrides it.
 */
export function sandboxEnv(env: MicroVmOptions['env']): Record<string, string> {
  return { IS_SANDBOX: '1', ...env }
}

export interface MicrosandboxSandboxOptions extends Omit<MicroVmOptions, 'image' | 'workDir' | 'ports'> {
  /** OCI image the sandbox boots. Defaults to {@link DEFAULT_IMAGE}. */
  image?: string
  /** Working directory the sandbox starts in. Defaults to {@link DEFAULT_WORK_DIR}. */
  workDir?: string
  /**
   * Guest ports to publish, as `guest → host`.
   *
   * Both sides are explicit because the runtime has no "pick a free one" mode this backend could
   * read back afterwards — unlike `docker port`, there is nothing to ask once the VM is up. A
   * caller that wants an ephemeral host port should choose one and pass it.
   */
  ports?: ReadonlyMap<number, number>
  /** Prefix for sandbox names, so several projects can share one runtime. */
  namePrefix?: string
}

export function createMicrosandboxSandbox(
  options: MicrosandboxSandboxOptions = {},
): SandboxProvider {
  const handles = new Map<string, MicroVmHandle>()
  const ports = options.ports ?? new Map<number, number>()

  // Cached per sandbox id: `session()` is called per use rather than held across a workflow step,
  // and a fresh handle each time would defeat the lazy acquisition behind it.
  const handleFor = (sandboxId: string): MicroVmHandle => {
    const existing = handles.get(sandboxId)
    if (existing !== undefined) {
      return existing
    }
    const created = createMicroVmHandle(sandboxId, {
      ...options,
      image: options.image ?? DEFAULT_IMAGE,
      workDir: options.workDir ?? DEFAULT_WORK_DIR,
      ports,
      env: sandboxEnv(options.env),
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
    const hostPort = ports.get(port)
    if (hostPort === undefined) {
      throw new MicrosandboxPortNotMappedError(port, [...ports.keys()])
    }
    // The sandbox is resolved before the URL is returned: a caller dialling an endpoint for a
    // sandbox that was never booted would otherwise get a URL and a connection refused.
    await handleFor(sandboxId).ready()
    const protocol = endpointOptions?.protocol ?? 'http'
    return { url: `${protocol}://127.0.0.1:${hostPort}` }
  }

  // `destroy()` removes the sandbox, so the cached handle is spent — keeping it would make a
  // long-lived provider grow by one dead entry per sandbox it ever tore down. The identity check
  // is what stops a teardown racing a re-`session()` from evicting the replacement.
  const session = (sandboxId: string): SandboxSession => {
    const handle = handleFor(sandboxId)
    const created = createMicrosandboxSession({ handle })
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
    backend: 'microsandbox',
    session,
    portEndpoint,
  } satisfies SandboxProvider
}
