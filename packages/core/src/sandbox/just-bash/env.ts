/**
 * Per-command environment, which the interpreter does not otherwise offer.
 *
 * `runCommand({ env })` is accepted by `just-bash` and then never applied — measured: a command
 * run with `env: { PROBE: 'x' }` sees `$PROBE` empty. Only the sandbox *constructor*'s `env`
 * reaches a command, and that one is fixed for the sandbox's lifetime, so the contract's
 * per-exec `env` needs a mechanism of its own.
 *
 * The mechanism is a shell that exports the variables and then `exec`s the caller's command.
 * Two things make that safe to build:
 *
 * - **The script is a constant.** Nothing from the caller is ever interpolated into shell text —
 *   names, values and argv all arrive as positional parameters, so there is no quoting to get
 *   wrong and no injection surface. Same discipline as `../local/journal.ts`'s wrapper.
 * - **`export "K=V"` takes the whole assignment as one word**, so a value may contain spaces,
 *   quotes, `$`, or a newline without changing how the script parses.
 *
 * The prefix's own `sh` is not a second interpreter — `just-bash` runs one — and `exec` replaces
 * it, so the caller's command keeps the process the handle refers to. Verified to reach a nested
 * `sh -c` too, which a bare `env K=V` prefix does not.
 */
import type { SandboxCommand } from '../contract'

/**
 * `$1` is how many `K=V` words follow; the rest is the command.
 *
 * Counting rather than scanning for a separator is what keeps a value that looks like the
 * separator from ending the list early.
 */
export const ENV_WRAPPER_SCRIPT
  = 'n=$1; shift; while [ "$n" -gt 0 ]; do export "$1"; shift; n=$((n-1)); done; exec "$@"'

/** POSIX name: letters, digits and underscore, not starting with a digit. */
const NAME = /^[A-Z_]\w*$/i

/** Raised for an env name the shell could not export as one word. */
export class JustBashEnvNameError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`'${key}' is not a usable environment variable name`)
    this.name = 'JustBashEnvNameError'
    this.key = key
  }
}

/**
 * The argv to hand the interpreter: the caller's own when there is nothing to export, and the
 * wrapper in front of it when there is.
 *
 * An unusable name is rejected rather than dropped or escaped. `export "1BAD=x"` would fail
 * inside the wrapper and take the whole command's exit code with it, which reports the caller's
 * command as broken instead of the env entry that is.
 */
export function envArgv(argv: SandboxCommand, env?: Record<string, string>): SandboxCommand {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) {
    return argv
  }
  for (const [key] of entries) {
    if (!NAME.test(key)) {
      throw new JustBashEnvNameError(key)
    }
  }
  return [
    'sh',
    '-c',
    ENV_WRAPPER_SCRIPT,
    // `$0` for the wrapper shell. Positional parameters start after it, so the count lands on
    // `$1` as the script expects.
    'sh',
    String(entries.length),
    ...entries.map(([key, value]) => `${key}=${value}`),
    ...argv,
  ]
}
