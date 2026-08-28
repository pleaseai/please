/**
 * `@pleaseai/core` — the core package of the `please` agent framework.
 *
 * The framework runs an existing coding-agent harness rather than writing an agent loop, so
 * what is exported here is deliberately narrow: a way to declare an agent, and the workspace
 * types that go with it. The harness adapter itself is the AI SDK's — imported from
 * `@ai-sdk/harness-claude-code` and friends, never re-exported through this package.
 *
 * Sandboxes live behind `./sandbox` (contract and declaration) and `./sandbox/docker` (a host
 * backend, kept out of this entry point so a Worker bundle never pulls the `docker` CLI in).
 */

export { defineAgent } from './agent/define'
export type {
  Agent,
  AgentDefinition,
  AgentSession,
  AgentTurn,
} from './agent/define'

export { readWorkspace, seedWorkspace } from './agent/workspace'
export type { WorkspaceFiles, WorkspaceSource, WorkspaceWriter } from './agent/workspace'
