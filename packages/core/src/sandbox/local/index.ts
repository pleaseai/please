/**
 * `@pleaseai/core/sandbox/local` — a host-process backend for the sandbox contract.
 *
 * **Host-only, and unisolated.** Everything here spawns real processes with the caller's own
 * uid on the caller's own filesystem, so this subpath must never be reached from a Cloudflare
 * Worker bundle — and must never be chosen for untrusted code. It is a separate entry point
 * for the first reason: importing `@pleaseai/core` or `@pleaseai/core/sandbox` pulls none of
 * it in. The second is a decision for whoever wires it; see `./provider.ts`.
 */

// Re-exported so a caller holding this subpath need not also import the contract to catch it.
// The class itself lives on the contract, because its whole purpose is one identity across
// backends — see `../contract/types.ts`.
export { SandboxFileNotFoundError } from '../contract'

export { DEFAULT_ENV_ALLOWLIST, resolveBaseEnv } from './env'
export type { LocalEnvOptions } from './env'

export { journalPaths, timeoutSeconds, wrapperArgv } from './journal'
export type { JournalMeta, JournalPaths } from './journal'

export { createLocalSandbox } from './provider'
export type { LocalSandboxOptions } from './provider'

export { createSandboxRoot, sandboxDirName } from './root'
export type { RootOptions, SandboxRoot } from './root'

export { createLocalSession } from './session'
export type { LocalSessionOptions } from './session'
