/**
 * Loading `just-bash`, and the two accommodations it needs here.
 *
 * The package is an **optional peer dependency**, not a dependency: it is ~megabytes of shell
 * interpreter that a caller using the Docker or local backend never runs, and eve treats it the
 * same way ("The `just-bash` package is not bundled with eve"). So it is imported dynamically
 * and its absence is reported as an actionable install instruction rather than a module
 * resolution failure from inside a workflow step.
 *
 * **The types below are structural copies, not imports of the vendor's.** That is the rule
 * `../contract/types.ts` states about itself and the reason is the same one: an `import type`
 * from `just-bash` would put the package in this subpath's generated `.d.ts`, so a consumer who
 * never installed the optional peer would fail to type-check against `@pleaseai/core`. Only the
 * surface actually used is copied.
 */

/** One chunk of a command's output, as `just-bash` reports it. */
export interface JustBashOutputMessage {
  type: 'stdout' | 'stderr'
  data: string
  timestamp: Date
}

/**
 * A running or finished command.
 *
 * `logs()` is **replayable** — it can be consumed repeatedly, before and after `wait()` — which
 * is what lets this backend answer `logs({ replay: true })` after a process has exited without
 * journalling anything. Measured, not assumed.
 */
export interface JustBashCommand {
  readonly cmdId: string
  readonly cwd: string
  readonly startedAt: Date
  exitCode: number | undefined
  logs: () => AsyncGenerator<JustBashOutputMessage, void, unknown>
  wait: () => Promise<{ exitCode: number }>
  kill: () => Promise<void>
}

/**
 * The vendor's `env` field is deliberately absent.
 *
 * It exists on the real parameter type and has no effect — a command run with
 * `env: { PROBE: 'x' }` sees `$PROBE` empty. Copying it here would offer a field that silently
 * does nothing; `./env.ts` carries the contract's per-exec env instead.
 */
export interface JustBashRunParams {
  cmd: string
  args?: string[]
  cwd?: string
  detached?: boolean
  signal?: AbortSignal
}

export interface JustBashSandbox {
  runCommand: (params: JustBashRunParams & { detached: true }) => Promise<JustBashCommand>
  writeFiles: (files: Record<string, { content: string, encoding?: 'utf-8' | 'base64' }>) => Promise<void>
  readFile: (path: string, encoding?: 'utf-8' | 'base64') => Promise<string>
  mkDir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  stop: () => Promise<void>
}

export interface JustBashSandboxOptions {
  cwd?: string
  env?: Record<string, string>
  defenseInDepth?: boolean
  [option: string]: unknown
}

interface JustBashModule {
  Sandbox: { create: (options?: JustBashSandboxOptions) => Promise<JustBashSandbox> }
}

/** Raised when the optional peer dependency is not installed. */
export class JustBashUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'the `just-bash` package is not installed. It is an optional peer dependency of '
      + '@pleaseai/core — run `bun add just-bash` to use @pleaseai/core/sandbox/just-bash.',
    )
    this.name = 'JustBashUnavailableError'
    this.cause = cause
  }
}

/**
 * Whether `just-bash`'s defence-in-depth layer can run on this runtime.
 *
 * It hardens the embedding process by monkey-patching Node globals, and one of its patches is
 * `Module._resolveFilename`. Under Bun that patch fails and the *first command* dies with
 * `DefenseInDepthBox: critical patches failed` — not the constructor, so a caller finds out one
 * layer away from the cause. Measured on Bun 1.3.14; the same call succeeds on Node 24.
 *
 * So the default follows the runtime rather than the vendor's, and the caller can always say
 * otherwise. Turning it off is not free — it is a layer of protection against a sandboxed
 * script reaching host globals — which is why this reports the runtime rather than deciding
 * silently for every runtime.
 */
export function defenseInDepthSupported(): boolean {
  return (globalThis as { Bun?: unknown }).Bun === undefined
}

/**
 * Whether a failed `import()` means the package is absent, rather than broken.
 *
 * Only a resolution failure naming this specifier counts. Two other things reach the same
 * `catch` and are not the same fact: a module-evaluation error, which means `just-bash` is
 * installed and threw while loading, and a resolution failure naming one of *its* dependencies,
 * which means the install is incomplete. Reporting either as "not installed" tells a caller to
 * run an install it has already run, and buries the real error inside a `cause` nothing reads.
 *
 * Measured on Bun 1.3.14: a missing package throws `ResolveMessage` with
 * `code: 'ERR_MODULE_NOT_FOUND'` and a message naming the specifier. `MODULE_NOT_FOUND` is
 * Node's CommonJS spelling of the same condition.
 */
function isMissingPackage(cause: unknown, specifier: string): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return false
  }
  return String((cause as Error | undefined)?.message ?? '').includes(specifier)
}

/**
 * Import `just-bash`, or explain that it is missing.
 *
 * The specifier is built at runtime so a bundler cannot decide to resolve the optional peer at
 * build time and fail a bundle that was never going to call this backend.
 */
export async function loadJustBash(): Promise<JustBashModule> {
  const specifier = 'just-bash'
  try {
    return (await import(/* @vite-ignore */ specifier)) as unknown as JustBashModule
  }
  catch (cause) {
    if (isMissingPackage(cause, specifier)) {
      throw new JustBashUnavailableError(cause)
    }
    throw cause
  }
}
