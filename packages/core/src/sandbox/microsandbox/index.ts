/**
 * `@pleasedev/core/sandbox/microsandbox` — a microVM backend for the sandbox contract.
 *
 * **Host-only.** Everything here drives a hypervisor through a native addon, so this subpath must
 * never be reached from a Cloudflare Worker bundle. It is a separate entry point for exactly that
 * reason: importing `@pleasedev/core` or `@pleasedev/core/sandbox` pulls none of it in.
 *
 * `microsandbox` is an **optional peer dependency**: install it to use this subpath. It is
 * imported dynamically, so its absence — or the absence of a native addon for the current
 * platform — is an actionable error rather than a resolution failure. See
 * {@link MicrosandboxUnavailableError}.
 *
 * **Verification status.** This backend is type-checked against the vendor's shipped declarations
 * and covered by a suite that runs only where the addon loads; it was written on a host where it
 * does not (`darwin-x64` has no addon). `./runtime.ts` states this in full, and the comments
 * throughout mark what is a decision versus what the vendor documents — no comment here reports a
 * measurement that was not taken.
 */

// Re-exported so a caller holding this subpath need not also import the contract to catch it.
// The class itself lives on the contract, because its whole purpose is one identity across
// backends — see `../contract/types.ts`.
export { SandboxFileNotFoundError } from '../contract'

export { createMicrosandboxFiles } from './files'

export { execArgv, execArgvBytes, execScript, spawnArgv } from './guest'
export type { GuestExecOptions, GuestProcess, GuestResult } from './guest'

export { createProcessHandle } from './process'
export type { ProcessHandleOptions } from './process'

export {
  readFullJournalState,
  readJournalMeta,
  readJournalState,
  toProcessExit,
  toProcessStatus,
} from './process-state'
export type { JournalState } from './process-state'

export {
  createMicrosandboxSandbox,
  DEFAULT_IMAGE,
  DEFAULT_WORK_DIR,
  MicrosandboxPortNotMappedError,
  sandboxEnv,
} from './provider'
export type { MicrosandboxSandboxOptions } from './provider'

export {
  isMicrosandboxAvailable,
  loadMicrosandbox,
  MicrosandboxUnavailableError,
} from './runtime'
export type {
  MicroExecEvent,
  MicroExecHandle,
  MicroExecOptionsBuilder,
  MicroExecOutput,
  MicroFsOps,
  MicroSandbox,
  MicroSandboxBuilder,
  MicroSandboxHandle,
  MicrosandboxModule,
} from './runtime'

export { createMicroVmHandle, sandboxName } from './sandbox'
export type { MicroVmHandle, MicroVmOptions } from './sandbox'

export { createMicrosandboxSession } from './session'
export type { MicrosandboxSessionOptions } from './session'
