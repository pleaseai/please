/**
 * Running commands inside an already-created microVM.
 *
 * The layer `../docker/exec.ts` is for that backend: everything above this file works in terms
 * of "run this argv, give me its output", and only this file knows the transport is a napi
 * binding rather than a CLI. Two differences from the Docker one are worth naming, because they
 * are the reason this is a separate file and not a copy:
 *
 * - **There is no process to spawn on the host.** `docker exec` is an OS process whose stdout is
 *   already a `ReadableStream`; here an exec is a native handle that yields events, so
 *   {@link spawnArgv} adapts those events into the stream the callers above expect.
 * - **Options are set, not spelled.** `cwd`, `env` and `timeout` are builder calls the vendor
 *   applies itself, so nothing on this path is assembled into a command line that a shell could
 *   reinterpret. Argv reaches the guest as argv.
 */
import type { MicroExecEvent, MicroExecOptionsBuilder, MicroSandbox } from './runtime'

export interface GuestResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface GuestExecOptions {
  cwd?: string
  env?: Readonly<Record<string, string>>
  /** Enforced by the vendor, which reports the timed-out exec as a non-zero exit. */
  timeout?: number
}

/**
 * Apply the options a caller set, and only those — an unset option is never spelled out.
 *
 * Generic over the builder rather than typed to the copy in `./runtime.ts`, so the callback this
 * returns is the one the vendor's `execWith` actually expects. That is what removes the cast this
 * file would otherwise need, and the reason `MicroExecOptionsBuilder` is written as a constraint.
 */
function configured<B extends MicroExecOptionsBuilder>(
  argv: readonly string[],
  options: GuestExecOptions,
): (builder: B) => B {
  const args = [...argv.slice(1)]
  return (builder) => {
    builder.args(args)
    if (options.cwd !== undefined) {
      builder.cwd(options.cwd)
    }
    if (options.env !== undefined) {
      builder.envs({ ...options.env })
    }
    if (options.timeout !== undefined) {
      builder.timeout(options.timeout)
    }
    return builder
  }
}

/** Run argv in the guest and collect its output as text. */
export async function execArgv(
  sandbox: MicroSandbox,
  argv: readonly string[],
  options: GuestExecOptions = {},
): Promise<GuestResult> {
  const [executable = 'sh'] = argv
  const output = await sandbox.execWith(executable, configured(argv, options))
  return { exitCode: output.code, stdout: output.stdout(), stderr: output.stderr() }
}

/** Run argv in the guest and collect its stdout as bytes. */
export async function execArgvBytes(
  sandbox: MicroSandbox,
  argv: readonly string[],
  options: GuestExecOptions = {},
): Promise<{ exitCode: number, stdout: Uint8Array, stderr: string }> {
  const [executable = 'sh'] = argv
  const output = await sandbox.execWith(executable, configured(argv, options))
  return { exitCode: output.code, stdout: output.stdoutBytes(), stderr: output.stderr() }
}

/** Run a `sh -c` script in the guest. Prefer argv; this is for the journal wrapper. */
export function execScript(
  sandbox: MicroSandbox,
  script: string,
  options: GuestExecOptions = {},
): Promise<GuestResult> {
  return execArgv(sandbox, ['sh', '-c', script], options)
}

export interface GuestProcess {
  /** Only stdout: every caller of this is reading a file through `cat` or `tail`. */
  stdout: ReadableStream<Uint8Array>
  kill: () => void
}

/**
 * Start argv in the guest without waiting for it, exposing its stdout as a stream.
 *
 * The vendor's handle is an async iterator of tagged events rather than a pipe, so the adaptation
 * is a pull loop: each `stdout` event becomes a chunk, and `exited` — or a `recv()` that answers
 * `null` — closes the stream. `stderr` events are dropped rather than merged, because every
 * caller here is reading one file and merging would corrupt it with whatever `tail` complained
 * about.
 *
 * `kill()` is best-effort and deliberately not awaited by the stream: it exists so a caller that
 * stops reading a `tail -f` can end it, and a rejection there would have nowhere to go.
 */
export async function spawnArgv(
  sandbox: MicroSandbox,
  argv: readonly string[],
  options: GuestExecOptions = {},
): Promise<GuestProcess> {
  const [executable = 'sh'] = argv
  const handle = await sandbox.execStreamWith(executable, configured(argv, options))

  let stopped = false
  const stdout = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      for (;;) {
        if (stopped) {
          controller.close()
          return
        }
        const event: MicroExecEvent | null = await handle.recv()
        if (event === null || event.kind === 'exited') {
          controller.close()
          return
        }
        if (event.kind === 'stdout' && event.data.byteLength > 0) {
          controller.enqueue(event.data)
          return
        }
      }
    },
    cancel: () => {
      stopped = true
      void handle.kill().catch(() => undefined)
    },
  })

  return {
    stdout,
    kill: () => {
      stopped = true
      void handle.kill().catch(() => undefined)
    },
  }
}
