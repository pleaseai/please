/**
 * `@pleaseai/core/sandbox/just-bash` — a virtual-shell backend for the sandbox contract.
 *
 * **Needs no daemon, no image and no host process**, because it runs no host process: `just-bash`
 * interprets the commands over an in-memory filesystem. It is the only one of the three backends
 * that could run inside a Worker bundle in principle — but it is still a separate entry point,
 * so importing `@pleaseai/core` or `@pleaseai/core/sandbox` pulls none of it in.
 *
 * `just-bash` is an **optional peer dependency**: install it to use this subpath. It is imported
 * dynamically, so its absence is an actionable error rather than a resolution failure — see
 * {@link JustBashUnavailableError}.
 *
 * What this backend cannot do is documented on `./provider.ts`, and none of it is a gap: no real
 * binaries, no ports, no live output, and no bytes that are not valid UTF-8.
 */

// Re-exported so a caller holding this subpath need not also import the contract to catch it.
// The class itself lives on the contract, because its whole purpose is one identity across
// backends — see `../contract/types.ts`.
export { SandboxFileNotFoundError } from '../contract'

export { ENV_WRAPPER_SCRIPT, envArgv, JustBashEnvNameError } from './env'

export {
  createJustBashFiles,
  JustBashBinaryUnsupportedError,
  resolveVirtualPath,
} from './files'

export { createProcessHandle, toProcessStatus } from './process'
export type { ProcessRecord } from './process'

export {
  createJustBashSandbox,
  DEFAULT_WORK_DIR,
  JustBashPortsUnavailableError,
} from './provider'
export type { JustBashSandboxOptions } from './provider'

export { defenseInDepthSupported, JustBashUnavailableError, loadJustBash } from './runtime'
export type {
  JustBashCommand,
  JustBashOutputMessage,
  JustBashRunParams,
  JustBashSandbox,
} from './runtime'

export { createJustBashHandle } from './sandbox'
export type { JustBashHandle, JustBashSandboxHandleOptions } from './sandbox'

export { createJustBashSession } from './session'
export type { JustBashSessionOptions } from './session'
