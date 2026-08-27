/*
 * Vendored from `chatbot-pf/pleaseworks` (`packages/sandbox-contract/src/index.ts`), relicensed from
 * FSL-1.1-MIT to Apache-2.0 by the copyright holder, Passion Factory, Inc.
 *
 * Comments below naming paths such as `apps/cf-orchestrator/…`, `run/run-workflow.ts` or
 * sibling packages refer to that originating codebase, not to this repository. They are kept
 * because they record why each obligation exists.
 */
// @pleaseai/sandbox-contract
//
// The sandbox surface `apps/cf-orchestrator` runs against, owned here rather than imported
// from any one vendor's SDK. See `./types.ts` for why the Cloudflare shapes are copied
// structurally instead of re-exported, and why this is a peer of the AI SDK's sandbox
// session rather than an extension of it.

export { SandboxNoExitRecordError, SandboxWaitTimeoutError } from './types'

export type {
  ProcessExit,
  ProcessFailure,
  ProcessLogCursor,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxFileContent,
  SandboxFileEncoding,
  SandboxFiles,
  SandboxFileStream,
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProcessHandle,
  SandboxProvider,
  SandboxSession,
  WaitForExitOptions,
} from './types'
