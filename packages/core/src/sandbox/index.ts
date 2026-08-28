/**
 * `@pleaseai/core/sandbox` — the backend contract, and the way to declare one.
 *
 * Runtime-neutral on purpose. A backend that spawns host processes (see `./docker`) lives
 * behind its own subpath so that importing this one from a Worker bundle pulls none of it in.
 */

export * from './contract'

export { DEFAULT_PORTS, DEFAULT_WORK_DIR, defineSandbox, resolveSandbox } from './define'
export type {
  ResolvedSandbox,
  SandboxBackendContext,
  SandboxBackendFactory,
  SandboxCreateContext,
  SandboxDefinition,
  SandboxSessionContext,
} from './define'
