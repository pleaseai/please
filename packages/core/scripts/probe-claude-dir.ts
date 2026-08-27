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

const sandboxes = createDockerSandbox({ image: IMAGE, workDir: WORK_DIR, ports: [8080] })
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

/**
 * Put `pnpm` on PATH before anything asks for it.
 *
 * The adapter's bootstrap runs `pnpm install`, and the official node images ship pnpm only
 * through corepack — so something has to enable it *first*. Neither sandbox hook can:
 * `onSession` runs after the adapter has started, and `onBootstrap` is documented as running
 * "after the harness adapter's own bootstrap has run". Nothing in the harness precedes it.
 *
 * The sandbox does. `createSession` resolves the container by session id, and the contract
 * session for that same id is the same container — so acquiring it here and running corepack
 * lands before the harness has looked at it. This is what `probe-adapter-bootstrap.ts` already
 * does with `session.run`; it is the image's business, not the framework's.
 */
async function enableCorepack(sandboxId: string): Promise<void> {
  const proc = await sandboxes.session(sandboxId).exec(['sh', '-c', 'corepack enable pnpm'])
  const exit = await proc.waitForExit()
  if (exit.code !== 0) {
    throw new Error(`corepack enable pnpm failed in the sandbox (exit ${exit.code})`)
  }
}

const sessionId = `claude-dir-probe-${Date.now()}`

// Everything that can create the container lives inside the `try`, including the corepack
// step: `enableCorepack` acquires the sandbox, so a failure there — or in `createSession` —
// used to leave a container running with nothing left to destroy it (cubic review, PR #7).
// The `finally` is written to run before a session exists, which is why `session` is a
// mutable binding rather than a `const` above.
let session: Awaited<ReturnType<typeof agent.createSession>> | undefined

try {
  await enableCorepack(sessionId)
  log('corepack', 'pnpm enabled in the container before the adapter bootstraps')
  session = await agent.createSession({ sessionId })

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

  // The exit code carries the verdict, so a run that measured nothing is not mistaken for one
  // that answered. A `SKIP` above still exits 0 on purpose — an absent daemon or credential is
  // not a failed measurement — but both ways of failing to measure are exit 1 (cubic review,
  // PR #7).
  if (knewCodename && toolCalls.length === 0) {
    log('')
    log('CONCLUSION', 'a seeded .claude workdir IS read — open question 1 answers yes')
  }
  else if (!knewCodename) {
    log('')
    log('CONCLUSION', 'the seeded CLAUDE.md did NOT reach the model — open question 1 answers no')
    process.exitCode = 1
  }
  else {
    // The codename came back, but so did a tool call — and the whole design of the probe is
    // that `activeTools: []` leaves no way to read the file. The answer proves nothing about
    // the system prompt, which makes this a failed measurement rather than a negative one.
    log('')
    log('CONCLUSION', `INCONCLUSIVE: the codename came back after ${toolCalls.length} tool call(s), which could have supplied it`)
    process.exitCode = 1
  }
}
finally {
  // The sandbox is destroyed either way: it exists from the moment `enableCorepack` acquires
  // it, whether or not a harness session was ever built on top.
  await session?.destroy()
  await sandboxes.session(sessionId).destroy()
  log('cleanup', 'session and container removed')
}
