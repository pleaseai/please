/**
 * One `just-bash` sandbox per id, created on first use.
 *
 * The analogue of `../docker/container.ts` and `../local/root.ts`, and the smallest of the
 * three: a sandbox here is an object in this process's heap, so there is nothing to name, adopt
 * or remove — `destroy()` drops it and the virtual filesystem goes with it.
 *
 * That is also the property a caller has to know about. **A just-bash sandbox cannot outlive the
 * host process.** For `../local` that would be a degradation worth working around, and it is
 * worked around, with an on-disk journal. Here there is nothing to journal *to*: the filesystem
 * the commands ran against was never on disk either, so a resumed handle would address a
 * sandbox whose entire contents are gone. `getProcess(id)` answering only within this process is
 * the honest shape of that, not a gap in it.
 *
 * The acquisition is memoised, but **a failed one is not** — the rule the other two backends
 * state, for the same reason: a rejected promise left in the latch is replayed by every later
 * call, so one transient failure would outlive itself.
 */
import type { JustBashSandbox, JustBashSandboxOptions } from './runtime'
import { defenseInDepthSupported, loadJustBash } from './runtime'

export interface JustBashSandboxHandleOptions {
  /** Working directory inside the virtual filesystem. Relative paths resolve against it. */
  cwd: string
  /** Environment every command in this sandbox starts with. */
  env?: Readonly<Record<string, string>>
  /**
   * Passed through to `just-bash`. Defaults to whether the runtime supports it — see
   * {@link defenseInDepthSupported}, which is a measurement rather than a preference.
   */
  defenseInDepth?: boolean
  /** Anything else `just-bash`'s own `SandboxOptions` accepts, passed through untouched. */
  vendorOptions?: Readonly<Record<string, unknown>>
}

export interface JustBashHandle {
  readonly cwd: string
  /** Resolve the sandbox, creating it on first call. */
  readonly ready: () => Promise<JustBashSandbox>
  /**
   * The sandbox if it already exists, without creating one.
   *
   * Discovery calls use this so that asking whether a sandbox ever ran a process answers
   * "nothing here" instead of standing one up as a side effect of the question.
   */
  readonly peek: () => JustBashSandbox | undefined
  /** Drop the sandbox and its virtual filesystem. Idempotent. */
  readonly destroy: () => Promise<void>
}

export function createJustBashHandle(options: JustBashSandboxHandleOptions): JustBashHandle {
  let acquisition: Promise<JustBashSandbox> | undefined
  let live: JustBashSandbox | undefined

  const acquire = async (): Promise<JustBashSandbox> => {
    const { Sandbox } = await loadJustBash()
    const vendor: JustBashSandboxOptions = {
      ...options.vendorOptions,
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      defenseInDepth: options.defenseInDepth ?? defenseInDepthSupported(),
    }
    const created = await Sandbox.create(vendor)
    live = created
    return created
  }

  const ready = (): Promise<JustBashSandbox> => (acquisition ??= acquire().catch(
    (cause: unknown) => {
      acquisition = undefined
      throw cause
    },
  ))

  return {
    cwd: options.cwd,
    ready,
    peek: () => live,
    destroy: async () => {
      const existing = live
      acquisition = undefined
      live = undefined
      // A sandbox that was never created is the state `destroy` promises, so there is nothing
      // to do — and `stop()` is best-effort past that, because the object is being dropped
      // either way and a failed stop must not leave the handle believing it still holds one.
      if (existing !== undefined) {
        await existing.stop()
      }
    },
  }
}
