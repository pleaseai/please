/**
 * `defineSandbox` — where an agent runs, stated once.
 *
 * Three things have to agree before a bridged harness can start: the backend's working
 * directory and published ports, the harness provider's `defaultWorkingDirectory` and `ports`,
 * and whatever prepares the container before the adapter reaches it. Today a caller repeats the
 * first two by hand, and a mismatch does not fail to type-check — it surfaces later as a bridge
 * that cannot be dialed. A definition states them once and hands them to both.
 *
 * That is why `backend` is a factory rather than a constructed provider: it is *given* the
 * resolved directory and ports instead of being told them a second time.
 */
import type { HarnessAgentSandboxConfig } from '@ai-sdk/harness/agent'
import type { SandboxProvider, SandboxSession } from './contract'

/** Where the sandbox runs and what it publishes, resolved from the definition. */
export interface SandboxBackendContext {
  readonly workDir: string
  readonly ports: readonly number[]
}

/**
 * A backend, not yet placed.
 *
 * `docker({ image })` and its future siblings return one of these. The framework applies the
 * placement, so a definition cannot disagree with itself about where the sandbox lives.
 */
export type SandboxBackendFactory = (context: SandboxBackendContext) => SandboxProvider

/** What `onCreate` is handed: the raw contract session for the container that will host the run. */
export interface SandboxCreateContext {
  readonly session: SandboxSession
  readonly sandboxId: string
}

/** What `onSession` is handed — the AI SDK's own shape, so a hook written for one fits the other. */
export type SandboxSessionContext
  = Parameters<NonNullable<HarnessAgentSandboxConfig['onSession']>>[0]

export interface SandboxDefinition {
  readonly backend: SandboxBackendFactory
  /** Defaults to {@link DEFAULT_WORK_DIR}. Sessions get their own directory underneath it. */
  readonly workDir?: string
  /** Defaults to {@link DEFAULT_PORTS}. A bridged adapter needs at least one. */
  readonly ports?: readonly number[]
  /**
   * Runs against the container **before the harness adapter bootstraps in it**.
   *
   * The AI SDK has no hook this early: `onBootstrap` is documented as running after the
   * adapter's own bootstrap, and `onSession` after the session exists. Anything the adapter's
   * first command depends on — `corepack enable pnpm` on an image that ships pnpm only through
   * corepack, a certificate, a proxy — therefore has nowhere to go. It fits here because the
   * backend owns the container: acquiring the contract session for a sandbox id lands before
   * the harness has looked at that same id.
   */
  readonly onCreate?: (context: SandboxCreateContext) => Promise<void>
  /**
   * Runs after the session's working directory exists and before the adapter starts, for fresh
   * and resumed sessions alike. Keep it idempotent. Files written here are per-session; an
   * agent's `workspace` is seeded through this same hook, before this callback runs.
   */
  readonly onSession?: (context: SandboxSessionContext) => Promise<void>
}

/** The directory a container starts in when a definition does not say. */
export const DEFAULT_WORK_DIR = '/work'

/**
 * The port a bridged adapter is assumed to listen on when a definition does not say.
 *
 * One port, because that is what the Claude Code adapter's bridge needs, and a sandbox that
 * publishes none cannot host it at all.
 */
export const DEFAULT_PORTS: readonly number[] = [8080]

export interface ResolvedSandbox {
  readonly workDir: string
  readonly ports: readonly number[]
  readonly sandboxes: SandboxProvider
  readonly definition: SandboxDefinition
}

/**
 * Declare a sandbox.
 *
 * The identity function is the point: it types the object at the definition site, where a
 * mistake is reported against the property that is wrong, rather than at the far end of the
 * agent that consumes it.
 */
export function defineSandbox(definition: SandboxDefinition): SandboxDefinition {
  return definition
}

/** Apply the defaults and build the backend. Called by `defineAgent`; exported for tests. */
export function resolveSandbox(definition: SandboxDefinition): ResolvedSandbox {
  const workDir = definition.workDir ?? DEFAULT_WORK_DIR
  const ports = definition.ports ?? DEFAULT_PORTS
  // An explicit `[]` bypasses the default and publishes nothing, and a bridged adapter reaches
  // its runtime over a published port — so the sandbox would come up and the first connect
  // would fail, a long way from the line that caused it.
  if (ports.length === 0) {
    throw new TypeError('sandbox `ports` cannot be empty: a bridged harness is reached over a published port')
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(`sandbox port '${port}' is not a valid TCP port`)
    }
  }
  return { workDir, ports, sandboxes: definition.backend({ workDir, ports }), definition }
}
