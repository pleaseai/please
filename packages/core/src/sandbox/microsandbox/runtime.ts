/**
 * Loading `microsandbox`, and the surface this backend uses from it.
 *
 * **Verification status, stated once and honestly.** The package ships a native addon per
 * platform and there is no `darwin-x64` build — measured on this repository's development host,
 * where `import('microsandbox')` throws `Error: microsandbox: unsupported platform darwin-x64`.
 * So this backend is written against the vendor's shipped type declarations and checked by
 * `tsc`; its behaviour is checked by `../../../test/sandbox/microsandbox/backend.test.ts`, which
 * skips itself wherever the addon cannot load. Comments here describe *decisions* and what the
 * vendor's own documentation states — where a claim would need a running microVM to confirm, it
 * says so rather than reporting a measurement that was never taken.
 *
 * **The types below are structural copies, not imports of the vendor's.** Same rule, and same
 * reason, as `../contract/types.ts` and `../just-bash/runtime.ts`: an `import type` from
 * `microsandbox` would put the package into this subpath's generated `.d.ts`, so a consumer who
 * never installed the optional peer would fail to type-check against `@pleaseai/core`. Only the
 * surface actually used is copied, and `./vendor-shape.ts` is the test that it still matches.
 */

/** One chunk of a streamed exec, as `microsandbox` reports it. */
export type MicroExecEvent
  = | { kind: 'started', pid: number }
    | { kind: 'stdout', data: Uint8Array }
    | { kind: 'stderr', data: Uint8Array }
    | { kind: 'exited', code: number }

/** A finished exec, collected. */
export interface MicroExecOutput {
  readonly code: number
  readonly success: boolean
  stdout: () => string
  stderr: () => string
  stdoutBytes: () => Uint8Array
}

/** A running exec. */
export interface MicroExecHandle {
  recv: () => Promise<MicroExecEvent | null>
  wait: () => Promise<{ readonly code: number }>
  collect: () => Promise<MicroExecOutput>
  kill: () => Promise<void>
}

/**
 * Per-exec options, as the vendor's fluent builder — the four setters this backend uses.
 *
 * Every method returns `this`, and every interface that hands this to a `configure` callback
 * takes the builder as a **type parameter** rather than naming this type directly. Both are
 * required for the copy to be what it claims: a *subset* the vendor's builder satisfies.
 *
 * Spelled the obvious way — the callback typed `(b: MicroExecOptionsBuilder) =>
 * MicroExecOptionsBuilder` — the vendor's own `execWith` is **not** assignable to it: a callback
 * parameter is checked contravariantly, so its return position demands the copy be assignable to
 * the vendor's builder, and the copy is missing nine of its methods. Making the *method* generic
 * fails for the opposite reason — a concrete vendor signature cannot satisfy a universally
 * quantified one. The parameter belongs to the interface, where the sandbox fixes it.
 *
 * `../../../test/sandbox/microsandbox/vendor-shape.test.ts` is what caught both attempts, and is
 * what keeps the third honest.
 */
export interface MicroExecOptionsBuilder {
  args: (args: string[]) => this
  cwd: (cwd: string) => this
  envs: (vars: Record<string, string>) => this
  timeout: (ms: number) => this
}

/** A read of a guest file, streamed. */
export interface MicroFsReadStream {
  recv: () => Promise<Uint8Array | null>
  collect: () => Promise<Uint8Array>
}

/** The guest filesystem, reached over the vendor's own channel rather than through a shell. */
/**
 * What a `stat` answers, narrowed to the one field this backend reads.
 *
 * The vendor's `FsMetadata` carries kind, mode, timestamps and a readonly flag as well. Copying
 * only `size` keeps the shape test asserting what is actually depended on: a vendor that adds a
 * field still matches, and one that drops `size` does not.
 */
export interface MicroFsMetadata {
  readonly size: number
}

export interface MicroFsOps {
  read: (path: string) => Promise<Uint8Array>
  readStream: (path: string) => Promise<MicroFsReadStream>
  write: (path: string, data: Uint8Array | string) => Promise<void>
  mkdir: (path: string) => Promise<void>
  stat: (path: string) => Promise<MicroFsMetadata>
  exists: (path: string) => Promise<boolean>
}

/**
 * A running sandbox this host process holds.
 *
 * `B` is the vendor's own exec-options builder. It defaults to the copy, which is what every
 * call site in this backend uses; the shape test is what instantiates it with the real one.
 */
export interface MicroSandbox<B extends MicroExecOptionsBuilder = MicroExecOptionsBuilder> {
  readonly name: string
  exec: (cmd: string, args?: Iterable<string>) => Promise<MicroExecOutput>
  execWith: (cmd: string, configure: (builder: B) => B) => Promise<MicroExecOutput>
  execStream: (cmd: string, args?: Iterable<string>) => Promise<MicroExecHandle>
  execStreamWith: (cmd: string, configure: (builder: B) => B) => Promise<MicroExecHandle>
  fs: () => MicroFsOps
  kill: () => Promise<void>
}

/** A sandbox recorded in the vendor's database, running or not. */
export interface MicroSandboxHandle<B extends MicroExecOptionsBuilder = MicroExecOptionsBuilder> {
  readonly name: string
  connect: () => Promise<MicroSandbox<B>>
  kill: () => Promise<void>
  remove: () => Promise<void>
}

/**
 * The creation builder.
 *
 * Only the setters this backend sets are copied. The vendor's own builder has many more —
 * network policy, volumes, snapshots, rlimits — and {@link MicrosandboxSandboxOptions}'s
 * `configure` escape hatch is what reaches them, for the reason `../just-bash/provider.ts`
 * gives about `vendorOptions`: re-declaring a dependency's surface here would make this
 * package drift against something it does not own.
 */
export interface MicroSandboxBuilder<B extends MicroExecOptionsBuilder = MicroExecOptionsBuilder> {
  image: (reference: string) => this
  cpus: (n: number) => this
  memory: (mib: number) => this
  workdir: (path: string) => this
  envs: (vars: Record<string, string>) => this
  port: (host: number, guest: number) => this
  labels: (labels: Record<string, string>) => this
  create: () => Promise<MicroSandbox<B>>
}

export interface MicrosandboxModule {
  Sandbox: {
    builder: (name: string) => MicroSandboxBuilder
    get: (name: string) => Promise<MicroSandboxHandle>
  }
}

/**
 * Raised when `microsandbox` cannot be loaded at all.
 *
 * It covers two different situations on purpose, because a caller's response to both is the
 * same — use another backend here — and the underlying error is kept as the `cause` for the one
 * who needs to tell them apart:
 *
 * - the optional peer is not installed;
 * - it is installed but has no native addon for this platform. Measured on `darwin-x64`, where
 *   the import throws `microsandbox: unsupported platform darwin-x64`. The vendor ships
 *   `darwin-arm64`, `linux-x64`, `linux-arm64` and both Windows targets.
 */
export class MicrosandboxUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'the `microsandbox` package could not be loaded. It is an optional peer dependency of '
      + '@pleaseai/core — run `bun add microsandbox` to use @pleaseai/core/sandbox/microsandbox, '
      + 'and note that it ships no native addon for every platform (there is none for '
      + 'darwin-x64). See the `cause` for which of the two applies.',
    )
    this.name = 'MicrosandboxUnavailableError'
    this.cause = cause
  }
}

/**
 * Import `microsandbox`, or explain that it could not be.
 *
 * The specifier is built at runtime so a bundler cannot decide to resolve the optional peer at
 * build time and fail a bundle that was never going to call this backend.
 */
export async function loadMicrosandbox(): Promise<MicrosandboxModule> {
  const specifier = 'microsandbox'
  try {
    return (await import(/* @vite-ignore */ specifier)) as unknown as MicrosandboxModule
  }
  catch (cause) {
    throw new MicrosandboxUnavailableError(cause)
  }
}

/**
 * Whether this host can load `microsandbox` at all.
 *
 * The suite's gate, and the shape `../docker/cli.ts`'s `isDockerAvailable` already established:
 * a backend with a prerequisite says so in a function a test can branch on, rather than letting
 * the whole file fail somewhere machine-specific. It answers only the load question — a host
 * that can load the addon may still lack the hypervisor the runtime needs.
 */
export async function isMicrosandboxAvailable(): Promise<boolean> {
  try {
    await loadMicrosandbox()
    return true
  }
  catch {
    return false
  }
}
