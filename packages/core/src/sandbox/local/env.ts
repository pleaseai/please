/**
 * What a process in a local sandbox inherits from the host, and what it does not.
 *
 * The Docker backend never needed this file: a container starts from the image's own
 * environment, so the only way a host variable reaches a sandboxed command is if the caller
 * put it there. On the host there is no such boundary — a naive backend hands `process.env`
 * straight to the agent's `bash` tool, and with it every AWS key, `GH_TOKEN` and
 * `SSH_AUTH_SOCK` the developer happens to be carrying.
 *
 * So the default is an allowlist, borrowed from flue's `local()` for the same reason it exists
 * there — `DEFAULT_LOCAL_ENV_ALLOWLIST` in `withastro/flue`, at
 * `packages/runtime/src/node/local-env.ts`. That path is flue's, not this repository's; naming
 * the repository is what makes the provenance checkable rather than a dead reference. Anything else is opt-in through {@link LocalEnvOptions.env}.
 */
import process from 'node:process'

/**
 * Host variables a shell needs to behave like a shell.
 *
 * **Adding an entry here is a security decision, not a convenience one.** Nothing on this
 * list should be sensitive on a typical developer machine: no tokens, no cloud credentials,
 * no agent sockets. A caller that wants one of those in the sandbox says so by name.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
]

export interface LocalEnvOptions {
  /**
   * Layered on top of {@link DEFAULT_ENV_ALLOWLIST}. A key set to `undefined` drops the
   * inherited default rather than adding an empty one, so a caller can subtract as well as add.
   *
   * Pass-through is deliberately spelled out rather than offered as a flag:
   *
   * ```ts
   * createLocalSandbox({ root, env: { GH_TOKEN: process.env.GH_TOKEN } })   // one variable
   * createLocalSandbox({ root, env: { ...process.env } })                   // everything
   * ```
   */
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Snapshot the host environment through the allowlist, then layer the caller's overrides.
 *
 * Taken once per sandbox and closed over, so every process it starts sees the same
 * environment for the sandbox's lifetime. Host mutations to `process.env` after that point
 * are deliberately not picked up: a sandbox whose environment changes underneath it makes
 * two runs of the same command incomparable.
 */
export function resolveBaseEnv(overrides?: LocalEnvOptions['env']): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      base[key] = value
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete base[key]
    }
    else {
      base[key] = value
    }
  }
  return base
}
