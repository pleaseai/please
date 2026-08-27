/*
 * Vendored from `chatbot-pf/pleaseworks` (`packages/harness-sandbox/src/index.ts`), relicensed from
 * FSL-1.1-MIT to Apache-2.0 by the copyright holder, Passion Factory, Inc.
 *
 * Comments below naming paths such as `apps/cf-orchestrator/…`, `run/run-workflow.ts` or
 * sibling packages refer to that originating codebase, not to this repository. They are kept
 * because they record why each obligation exists.
 */
// @pleaseai/harness-sandbox
//
// The AI SDK harness's `HarnessV1SandboxProvider`, implemented over
// `@pleaseai/sandbox-contract`. Written once against the contract, it serves every backend
// behind it — Cloudflare, e2b, or one that does not exist yet — with no harness-shaped code
// in any of them.

export { splitProcessStreams } from './demux'
export type { SplitProcessStreams } from './demux'

export { createFileSurface, parentDirectory, sliceLines, toBase64 } from './files'
export type { HarnessFileSurface } from './files'

export { createProcessSurface } from './process'
export type { HarnessProcessSurface, ProcessSurfaceOptions } from './process'

export { createHarnessSandboxProvider } from './provider'
export type { HarnessSandboxProviderOptions } from './provider'

export { createHarnessSandboxSession } from './session'
export type { HarnessSandboxSessionOptions } from './session'
