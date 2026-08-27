/**
 * Open question 1: does a `.claude` directory seeded into the session workdir mean anything?
 *
 * `docs/project-layout.md` leaves this open, and it is the question the other three wait on:
 * if the Agent SDK reads a seeded `.claude/`, then the source format for skills, the
 * permission story and the whole "the harness's ecosystem comes along" claim are settled
 * together. The adapter's own source says it should — the bridge never passes
 * `settingSources`, and the SDK documents the omitted default as "all sources are loaded
 * (matches CLI defaults) ... Must include 'project' to load CLAUDE.md files" — but that is an
 * inference from two documents, not a measurement.
 *
 * **The measurement only works with every tool switched off.** With `read` or `bash` available
 * the agent could simply open `CLAUDE.md` and answer from it, which proves nothing about the
 * system prompt. `activeTools: []` removes that path, so a correct answer can only have come
 * from the instructions the runtime was started with.
 *
 * Run:  bun run scripts/probe-claude-dir.ts
 */
import process from 'node:process'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createDockerSandbox, isDockerAvailable } from '../src/sandbox/docker'
import { createHarnessSandboxProvider } from '../src/sandbox/harness'

const IMAGE = process.env.PROBE_IMAGE ?? 'node:22-bookworm'
const WORK_DIR = '/work'

/** Unique enough that no model could produce it without having been told. */
const CODENAME = 'XYZZY-7702-QUOKKA'

/**
 * Written by a `.claude/settings.json` hook, if such a hook runs at all.
 *
 * Resolved inside `onSession`: the framework composes each session's directory underneath the
 * sandbox default rather than using the sandbox default itself, so the path is only known once
 * the session exists.
 */
let hookMarker: string | undefined

const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AI_GATEWAY_API_KEY']

function log(step: string, detail = ''): void {
  process.stdout.write(`${step}${detail === '' ? '' : `  ${detail}`}\n`)
}

if (!await isDockerAvailable()) {
  log('SKIP', 'no Linux-container docker daemon is reachable')
  process.exit(0)
}
if (!CREDENTIALS.some(name => process.env[name])) {
  log('SKIP', `needs one of ${CREDENTIALS.join(', ')} in the environment`)
  process.exit(0)
}

const sandboxes = createDockerSandbox({
  image: IMAGE,
  workDir: WORK_DIR,
  ports: [8080],
  // The adapter's bootstrap runs `pnpm`, which the official node images ship only via corepack.
  setupCommands: ['corepack enable pnpm'],
})
const sandbox = createHarnessSandboxProvider({
  sandboxes,
  defaultWorkingDirectory: WORK_DIR,
  ports: [8080],
})

const claudeMd = [
  '# Project conventions',
  '',
  `The project codename is ${CODENAME}.`,
  'When asked for the project codename, reply with exactly that string and nothing else.',
  '',
].join('\n')

// A hook is the second, independent probe: it is a side effect the model cannot fake, so a
// marker file appearing proves `.claude/settings.json` was read even if the prompt answer is
// somehow ambiguous.
function settingsJson(marker: string): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: `touch ${marker}` }] },
      ],
    },
  }, null, 2)
}

const agent = new HarnessAgent({
  harness: createClaudeCode({
    auth: 'auto',
    model: process.env.PROBE_MODEL ?? 'claude-sonnet-5',
    // Pinned explicitly: this host has ANTHROPIC_BASE_URL pointing at an org gateway, and the
    // credential that reaches the sandbox is a Console key — sending it anywhere but Anthropic's
    // own endpoint is a guaranteed 401. Override via PROBE_BASE_URL for a gateway credential.
    env: { ANTHROPIC_BASE_URL: process.env.PROBE_BASE_URL ?? 'https://api.anthropic.com' },
  }),
  sandbox,
  // Every built-in tool off, so nothing can read the file the answer is about.
  activeTools: [],
  sandboxConfig: {
    onSession: async ({ session, sessionWorkDir }) => {
      hookMarker = `${sessionWorkDir}/.hook-fired`
      await session.writeTextFile({ path: `${sessionWorkDir}/CLAUDE.md`, content: claudeMd })
      await session.writeTextFile({
        path: `${sessionWorkDir}/.claude/settings.json`,
        content: settingsJson(hookMarker),
      })
      log('seeded', `${sessionWorkDir}/CLAUDE.md and .claude/settings.json`)
    },
  },
})

const sessionId = `claude-dir-probe-${Date.now()}`
const session = await agent.createSession({ sessionId })

try {
  log('turn', 'asking for the codename with every tool disabled')
  const result = await agent.generate({
    session,
    prompt: 'What is the project codename? Answer with the codename only.',
  })

  const text = result.text ?? ''
  const toolCalls = result.steps.flatMap(step => step.toolCalls)
  const knewCodename = text.includes(CODENAME)

  log('answer', JSON.stringify(text.slice(0, 200)))
  log('toolCalls', String(toolCalls.length))

  const contractSession = sandboxes.session(sessionId)
  const hookFired = hookMarker !== undefined && (await contractSession.exists(hookMarker)).exists

  log('')
  log('=== VERDICT ===')
  log('CLAUDE.md reached the system prompt:', knewCodename ? 'YES' : 'NO')
  log('answered without using any tool:', toolCalls.length === 0 ? 'YES' : `NO (${toolCalls.length})`)
  log('.claude/settings.json hook ran:', hookFired ? 'YES' : 'NO')

  if (knewCodename && toolCalls.length === 0) {
    log('')
    log('CONCLUSION', 'a seeded .claude workdir IS read — open question 1 answers yes')
  }
  else if (!knewCodename) {
    log('')
    log('CONCLUSION', 'the seeded CLAUDE.md did NOT reach the model — open question 1 answers no')
  }
}
finally {
  await session.destroy()
  await sandboxes.session(sessionId).destroy()
  log('cleanup', 'session and container removed')
}
