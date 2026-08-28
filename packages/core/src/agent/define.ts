/**
 * `defineAgent` — what an agent is made of, in one place.
 *
 * It composes rather than abstracts. The harness adapter arrives as the AI SDK's own value
 * (`createClaudeCode()`, `createCodex()`, …) and is never wrapped or re-exported: the harness
 * boundary belongs to the AI SDK, and a wrapper here would be a maintenance obligation that
 * buys nothing. What this adds is the part no adapter exposes — a sandbox to run in, and a
 * workspace directory to carry into it.
 *
 * That second one is the whole point. `agents`, `skills` and `settingSources` are absent from
 * every adapter's settings, so an existing `.claude/` project reaches the runtime through the
 * session's working directory or not at all. `workspace` makes that route a declared input.
 */
import type {
  HarnessAgentAdapter,
  HarnessAgentPermissionMode,
} from '@ai-sdk/harness/agent'
import type { SandboxDefinition } from '../sandbox/define'
import type { WorkspaceFiles, WorkspaceSource } from './workspace'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { resolveSandbox } from '../sandbox/define'
import { createHarnessSandboxProvider } from '../sandbox/harness'
import { readWorkspace, seedWorkspace } from './workspace'

export interface AgentDefinition {
  /** The AI SDK harness adapter, unwrapped. */
  readonly harness: HarnessAgentAdapter
  readonly sandbox: SandboxDefinition
  /** A directory (or its inlined contents) seeded into every session's working directory. */
  readonly workspace?: WorkspaceSource
  /** Appended to the runtime's own system prompt where the adapter supports it. */
  readonly instructions?: string
  /**
   * Built-in tool permission mode. **Not the whole permission model**: a `deny` rule in a
   * `.claude/settings.json` carried by `workspace` outranks this on both routes it takes into
   * the runtime, measured — a tool-wide deny removes the tool rather than gating the call.
   */
  readonly permissionMode?: HarnessAgentPermissionMode
}

type GenerateResult = Awaited<ReturnType<HarnessAgent['generate']>>

export interface AgentTurn {
  readonly text: string
  /** Names of the tools the runtime called, in order. `Agent` and `Skill` appear here too. */
  readonly toolCalls: readonly string[]
  readonly usage: GenerateResult['usage']
  /** The AI SDK result, unmodified, for everything this shape does not carry. */
  readonly result: GenerateResult
}

export interface AgentSession {
  readonly sessionId: string
  /** The session's own directory inside the sandbox, where the workspace was seeded. */
  readonly workDir: string
  prompt: (prompt: string) => Promise<AgentTurn>
  /** Read a file back, relative to {@link workDir} unless the path is absolute. */
  readTextFile: (path: string) => Promise<string>
  /** Ends the session and removes the sandbox behind it. */
  close: () => Promise<void>
}

export interface Agent {
  createSession: (options?: { sessionId?: string }) => Promise<AgentSession>
}

/**
 * Exported for its own test, not through the package root.
 *
 * The empty-steps guard is the reason it is a function at all: `result.text` reads through to
 * the final step and throws when there is none, so a turn that produced no step — which a
 * follow-up prompt against a session whose previous turn left work running can do — would reach
 * a caller as a `TypeError` from inside the AI SDK rather than as an empty answer.
 */
export function turnFrom(result: GenerateResult): AgentTurn {
  return {
    text: result.steps.length === 0 ? '' : (result.text ?? ''),
    toolCalls: result.steps.flatMap(step => step.toolCalls).map(call => call.toolName),
    usage: result.usage,
    result,
  }
}

export function defineAgent(definition: AgentDefinition): Agent {
  const { workDir, ports, sandboxes, definition: sandboxDefinition } = resolveSandbox(
    definition.sandbox,
  )
  const sandbox = createHarnessSandboxProvider({
    sandboxes,
    defaultWorkingDirectory: workDir,
    ports,
  })

  // Read once, not per session: the directory is the same for every session, and a local run
  // that creates several would otherwise walk the host filesystem again for each.
  let workspace: Promise<WorkspaceFiles> | undefined

  /**
   * A `HarnessAgent` per session, deliberately.
   *
   * `onSession` reports `sessionWorkDir` but carries no session id, so a callback shared across
   * sessions cannot say which one it was told about. A per-session closure can, and the object
   * is only settings — building one costs nothing next to the container it is about to start.
   */
  const buildAgent = (capture: (workDir: string) => void): HarnessAgent => new HarnessAgent({
    harness: definition.harness,
    sandbox,
    ...(definition.instructions === undefined ? {} : { instructions: definition.instructions }),
    ...(definition.permissionMode === undefined
      ? {}
      : { permissionMode: definition.permissionMode }),
    sandboxConfig: {
      onSession: async (context) => {
        capture(context.sessionWorkDir)
        if (definition.workspace !== undefined) {
          // Memoise the read, **not its failure**. A rejected promise left in the latch would be
          // replayed by every later session without ever touching the filesystem again, so one
          // transient `EMFILE` would make the agent permanently unable to seed — the same rule
          // `sandbox/docker/container.ts` and `sandbox/harness/session.ts` already follow.
          workspace ??= readWorkspace(definition.workspace).catch((cause: unknown) => {
            workspace = undefined
            throw cause
          })
          await seedWorkspace(context.session, context.sessionWorkDir, await workspace)
        }
        // The definition's own hook runs last, so it can overwrite anything the workspace
        // seeded rather than being overwritten by it.
        await sandboxDefinition.onSession?.(context)
      },
    },
  })

  return {
    createSession: async (options) => {
      const sessionId = options?.sessionId ?? crypto.randomUUID()
      let sessionWorkDir: string | undefined
      const agent = buildAgent((dir) => {
        sessionWorkDir = dir
      })

      let session: Awaited<ReturnType<HarnessAgent['createSession']>>
      try {
        // `onCreate` acquires the container, so from here on a failure has something to clean
        // up — *its own* included. The call that runs the hook is what starts the container, so
        // a hook that then rejects (`corepack enable` exiting non-zero, a proxy unreachable)
        // leaves one running behind a `createSession` that never returned a handle to reap it.
        await sandboxDefinition.onCreate?.({
          session: sandboxes.session(sessionId),
          sandboxId: sessionId,
        })
        session = await agent.createSession({ sessionId })
      }
      catch (cause) {
        // Without this the container started above outlives the failed call with nothing left
        // holding a handle to reap it — and on a paid backend it bills until its own timeout.
        // Unconditional, including when the caller named the id. Naming is not resuming: the
        // AI SDK takes `createSession` as the fresh path and `resumeSession` as the returning
        // one, a `sessionId` alone creates a new session under that name, and resumable state
        // travels in `resumeFrom` — which this API does not expose. So there is no session to
        // preserve here, and a container this call woke would otherwise be left to bill.
        await sandboxes.session(sessionId).destroy().catch(() => {})
        throw cause
      }

      const resolve = (path: string): string =>
        path.startsWith('/') ? path : `${sessionWorkDir ?? workDir}/${path}`

      return {
        sessionId,
        workDir: sessionWorkDir ?? workDir,
        prompt: async prompt => turnFrom(await agent.generate({ session, prompt })),
        readTextFile: async (path) => {
          const { content } = await sandboxes.session(sessionId).readFile(resolve(path))
          return content
        },
        close: async () => {
          try {
            await session.destroy()
          }
          finally {
            await sandboxes.session(sessionId).destroy()
          }
        },
      }
    },
  }
}
