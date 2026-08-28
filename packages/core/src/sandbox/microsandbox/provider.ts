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

/**
 * The same handle, with every call that reaches the runtime held behind an in-flight teardown.
 *
 * A sandbox id resolves to a sandbox *name*, and acquiring a name adopts whatever the runtime's
 * database already has under it — which is the property that makes an id resumable across host
 * processes, and the reason a replacement handle is not safely independent of the one being torn
 * down. Without this gate, a `session(id)` arriving during a `destroy(id)` builds a fresh handle,
 * adopts the very VM that destroy is removing, and is left holding a machine that is about to be
 * killed underneath it.
 *
 * The teardown's own failure is swallowed here on purpose: it belongs to the caller that asked
 * for the destroy. A caller that merely queued behind it wants the timing, not the error — and a
 * failed teardown that poisoned every later session would turn one bad destroy into a permanently
 * unusable sandbox id.
 *
 * `../local/root.ts` states the same rule for a directory rather than a VM.
 */
function gatedOn(teardown: Promise<void>, handle: MicroVmHandle): MicroVmHandle {
  const settled = teardown.catch(() => undefined)
  return {
    name: handle.name,
    ready: async () => {
      await settled
      return handle.ready()
    },
    peek: async () => {
      await settled
      return handle.peek()
    },
    remove: async () => {
      await settled
      return handle.remove()
    },
  }
}

export function createMicrosandboxSandbox(
  options: MicrosandboxSandboxOptions = {},
): SandboxProvider {
  const handles = new Map<string, MicroVmHandle>()
  const teardowns = new Map<string, Promise<void>>()
  // Copied, not aliased: the map decides both what the VM publishes at build time and what
  // `portEndpoint` answers afterwards. Holding the caller's own map would let a mutation after
  // the VM is up change the answer without changing the mapping, handing back a URL for a host
  // port nothing is forwarding.
  const ports = new Map(options.ports ?? [])

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
    const teardown = teardowns.get(sandboxId)
    const handle = teardown === undefined ? created : gatedOn(teardown, created)
    handles.set(sandboxId, handle)
    return handle
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
        // Evicted before the teardown is awaited, not in a `finally` after it. Awaiting first
        // leaves a window in which a new `session(id)` finds this handle still registered and
        // adopts it — and the identity check would then still pass, so this call would evict the
        // new session's handle on its way out. `../just-bash/provider.ts` says the same.
        if (handles.get(sandboxId) === handle) {
          handles.delete(sandboxId)
        }
        // Published while it runs, so the replacement handle a concurrent `session(id)` builds
        // waits it out instead of adopting the VM it is removing — see {@link gatedOn}. Evicting
        // early without this trades one race for another: `../just-bash` needs no equivalent,
        // because a new just-bash handle is an independent virtual filesystem rather than a
        // second claim on the same named machine.
        const teardown = created.destroy().finally(() => {
          if (teardowns.get(sandboxId) === teardown) {
            teardowns.delete(sandboxId)
          }
        })
        teardowns.set(sandboxId, teardown)
        await teardown
      },
    }
  }

  return {
    backend: 'microsandbox',
    session,
    portEndpoint,
  } satisfies SandboxProvider
}
