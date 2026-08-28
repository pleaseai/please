/**
 * Claude Code, running in a local Docker sandbox, fixing a file it was handed.
 *
 * The agent itself is declared in `src/agent.ts`; this file only drives one turn and reports
 * what happened. What runs inside the container is the Claude Agent SDK
 * (https://code.claude.com/docs/en/agent-sdk/overview), reached over a websocket bridge the
 * adapter installs there — so the sandbox has to publish a port and reach the registry.
 *
 * Needs a Linux-container docker daemon and an Anthropic credential in the environment.
 * Run:  bun run examples/claude-code-docker/index.ts
 */
import process from 'node:process'
import { isDockerAvailable } from '@pleaseai/core/sandbox/docker'
import agent from './src/agent'

function log(step: string, detail = ''): void {
  process.stdout.write(`${step}${detail === '' ? '' : `  ${detail}`}\n`)
}

async function main(): Promise<void> {
  if (!await isDockerAvailable()) {
    log('SKIP', 'no Linux-container docker daemon is reachable')
    return
  }
  if (process.env.ANTHROPIC_API_KEY === undefined && process.env.ANTHROPIC_AUTH_TOKEN === undefined) {
    log('SKIP', 'needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment')
    return
  }

  // The first session pays for the adapter's bootstrap inside the container — pnpm install,
  // then the Claude Code CLI — so expect roughly half a minute before the turn starts.
  log('session', 'starting the container and bootstrapping the runtime')
  const session = await agent.createSession()

  try {
    log('workspace', session.workDir)
    log('turn', 'asking the agent to fix sum.js')

    // The verifier is a subagent, and it exists only as `.claude/agents/verifier.md` inside the
    // seeded workspace. Asking for it by name is what makes this run prove the claim: an `Agent`
    // tool call in the output means a file this example wrote was read as a subagent definition.
    //
    // The verdict does not come back in this turn, and that is the runtime's behaviour rather
    // than a shortcut here: subagents run in the background by default, so the turn ends with
    // the verification still in flight. Only `background: true` is expressible in a subagent
    // file, and it forces the opposite.
    const turn = await session.prompt(
      'sum.js has a bug: sum() skips the last number. Fix the file, then use the verifier agent'
      + ' to confirm the fix, and say what was wrong.',
    )

    log('')
    log('=== answer ===')
    log(turn.text)
    log('')
    log('=== sum.js, as the agent left it ===')
    log(await session.readTextFile('sum.js'))
    // `Agent` in this list is the point of the example: the subagent it names came from the
    // seeded workspace, not from any adapter setting.
    log('tools used', turn.toolCalls.join(', ') || 'none')
    log('usage', JSON.stringify(turn.usage))
  }
  finally {
    await session.close()
    log('cleanup', 'session and container removed')
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
