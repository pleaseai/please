/**
 * Open question 2: where do permissions come from?
 *
 * `docs/project-layout.md` asks this, and open question 1's answer turned it from a
 * hypothetical into a real conflict: a `.claude/settings.json` seeded into the session workdir
 * is* read, and `permissionMode`'s three values describe the same thing a settings file
 * describes. One of them has to win, and which one decides whether the permission model can be
 * claimed as the harness's or stays something this framework flattens.
 *
 * The adapter's own source (`@ai-sdk/harness-claude-code@1.0.94`,
 * `src/bridge/index.ts:139-234`) says the answer is not one answer but two, because
 * `permissionMode` takes two different routes into the SDK:
 *
 * - **`allow-all` with every built-in tool active** — the fast path. The query runs with
 *   `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`, and the
 *   adapter passes **no** `settings` option at all. The seeded file is the only permission
 *   source in play.
 * - **anything else** — the query runs with `permissionMode: 'default'` (or `'acceptEdits'`)
 *   and* an adapter-built `settings` object (`{ permissions: { ask: [...] }, sandbox: … }`).
 *   Now there are two settings sources: the adapter's inline one and the seeded file.
 *
 * So the probe measures both paths, with the same seeded file, and lets them disagree.
 *
 * **The seed is a `deny` rule, and that choice is the measurement.** An `ask` rule cannot be
 * read off a result — the adapter's `canUseTool` auto-approves anything `allow-all` does not
 * hold back, so an honoured `ask` and an ignored one look identical from outside. A `deny` has
 * no such escape: either the command ran or it did not.
 *
 * **The evidence is not the model's word, and not a file's existence either.** The agent is
 * asked to write `uname -r` into a marker with the Bash tool. `uname -r` inside this container
 * is a string the model has no way to produce without executing something — and every other
 * tool that could create the file (`write`, `edit`) is visible in the result's tool calls, so a
 * marker created any other way is reported as inconclusive rather than counted.
 *
 * Run:  bun run scripts/probe-permissions.ts
 */
import process from 'node:process'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createDockerSandbox, isDockerAvailable } from '../src/sandbox/docker'
import { createHarnessSandboxProvider } from '../src/sandbox/harness'

const IMAGE = process.env.PROBE_IMAGE ?? 'node:22-bookworm'
const WORK_DIR = '/work'
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AI_GATEWAY_API_KEY']

/**
 * Both spellings, because the point is to leave no doubt about the rule's *reach* when the
 * verdict is "ignored". A tool-wide `Bash` and a wildcard `Bash(*)` are the two forms the
 * settings documentation uses; a run where neither bit cannot be explained by syntax.
 */
const DENY_BASH = JSON.stringify({ permissions: { deny: ['Bash', 'Bash(*)'] } }, null, 2)

interface ProbeCase {
  readonly id: string
  /** How the agent is configured. */
  readonly title: string
  /** What that configuration makes the adapter send to the SDK. */
  readonly adapterPath: string
  /** Whether this case seeds the deny rule at all. The control does not. */
  readonly seedDeny: boolean
  /** Present only to push the adapter off its bypass fast path. */
  readonly inactiveTools?: readonly ['webSearch']
}

const CASES: readonly ProbeCase[] = [
  // Runs first, because a failure here voids the two that follow rather than merely losing a
  // reading: without it, "the command did not run" cannot be told apart from "the command
  // never runs in this setup", and every deny would look honoured for free.
  {
    id: 'control',
    title: 'no deny rule seeded, every built-in tool active',
    adapterPath: 'bypassPermissions + allowDangerouslySkipPermissions, no settings option',
    seedDeny: false,
  },
  {
    id: 'bypass',
    title: 'permissionMode allow-all, every built-in tool active',
    adapterPath: 'bypassPermissions + allowDangerouslySkipPermissions, no settings option',
    seedDeny: true,
  },
  {
    id: 'settings',
    title: 'permissionMode allow-all, webSearch inactive',
    adapterPath: 'permissionMode default + an adapter-injected settings object',
    seedDeny: true,
    inactiveTools: ['webSearch'],
  },
]

interface CaseOutcome {
  readonly bashRan: boolean
  readonly bashCalls: number
  readonly foreignWriteCalls: number
  readonly answer: string
}

function log(step: string, detail = ''): void {
  process.stdout.write(`${step}${detail === '' ? '' : `  ${detail}`}\n`)
}

/** The contract-level session a backend hands back, named once so the helpers can take it. */
type SandboxSessionOf = ReturnType<ReturnType<typeof createDockerSandbox>['session']>

/**
 * Put `pnpm` on PATH before the adapter's bootstrap asks for it.
 *
 * Same reason as `probe-adapter-bootstrap.ts` and `probe-claude-dir.ts`: the official node
 * images ship pnpm through corepack only, and neither sandbox hook runs early enough to enable
 * it — `onSession` fires after the adapter has started and `onBootstrap` after its bootstrap.
 * The contract session resolves the same container by session id, so doing it here lands first.
 */
async function enableCorepack(session: SandboxSessionOf, sandboxId: string): Promise<void> {
  const proc = await session.exec(['sh', '-c', 'corepack enable pnpm'])
  const exit = await proc.waitForExit()
  if (exit.code !== 0) {
    throw new Error(`corepack enable pnpm failed in ${sandboxId} (exit ${exit.code})`)
  }
}

/**
 * The container's own kernel release, read the same way the agent will be asked to read it.
 *
 * This is the control. It is taken through the contract session — not the harness — so the
 * value the agent produces is compared against something the agent had no part in.
 */
async function kernelRelease(session: SandboxSessionOf, path: string): Promise<string> {
  const proc = await session.exec(['sh', '-c', `uname -r > ${path}`])
  const exit = await proc.waitForExit()
  if (exit.code !== 0) {
    throw new Error(`uname failed in the sandbox (exit ${exit.code})`)
  }
  const file = await session.readFile(path)
  return file.content.trim()
}

/**
 * The agent under test: one harness over one sandbox, with the deny rule seeded into it.
 *
 * Split out from `runCase` so the helpers below can name its types. The agent's tool set is
 * inferred from the adapter, and spelling that type by hand is how a parameter annotation goes
 * quietly stale against the package it describes.
 */
function buildAgent(input: {
  probeCase: ProbeCase
  sandboxes: ReturnType<typeof createDockerSandbox>
  onSeed: (marker: string) => void
}) {
  return new HarnessAgent({
    harness: createClaudeCode({
      auth: 'auto',
      model: process.env.PROBE_MODEL ?? 'claude-sonnet-5',
      // Same pin as probe-claude-dir.ts: this host's ANTHROPIC_BASE_URL points at an org
      // gateway that the credential reaching the sandbox may not be minted for.
      //
      // `IS_SANDBOX` is deliberately *not* here. The first run of this probe died before any
      // permission could be read — `node:22-bookworm` runs as root and the CLI refuses the
      // bypass mode outright with `--dangerously-skip-permissions cannot be used with
      // root/sudo privileges for security reasons` — and the fix belongs to the backend, not
      // to a script: `createDockerSandbox` now declares `IS_SANDBOX=1` for every container it
      // creates (`containerEnv`). So this probe also stands as the check that it does.
      env: { ANTHROPIC_BASE_URL: process.env.PROBE_BASE_URL ?? 'https://api.anthropic.com' },
    }),
    sandbox: createHarnessSandboxProvider({
      sandboxes: input.sandboxes,
      defaultWorkingDirectory: WORK_DIR,
      ports: [8080],
    }),
    // Present only in the second case, and only to push the adapter off its bypass fast path.
    inactiveTools: input.probeCase.inactiveTools,
    sandboxConfig: {
      onSession: async ({ session, sessionWorkDir }) => {
        input.onSeed(`${sessionWorkDir}/.bash-ran`)
        if (!input.probeCase.seedDeny) {
          log('seeded', 'nothing — this is the control')
          return
        }
        await session.writeTextFile({
          path: `${sessionWorkDir}/.claude/settings.json`,
          content: DENY_BASH,
        })
        log('seeded', `${sessionWorkDir}/.claude/settings.json denying Bash`)
      },
    },
  })
}

type ProbeAgent = ReturnType<typeof buildAgent>
type ProbeSession = Awaited<ReturnType<ProbeAgent['createSession']>>

/**
 * One case, end to end: a fresh container, the deny rule seeded into it, one turn, one reading.
 *
 * Each case gets its own sandbox rather than reusing one. The cases differ only in what the
 * adapter sends the SDK, and a shared container would leave the first case's marker file and
 * session state sitting where the second case's evidence has to be read.
 */
async function runCase(probeCase: ProbeCase): Promise<CaseOutcome> {
  const sandboxes = createDockerSandbox({ image: IMAGE, workDir: WORK_DIR, ports: [8080] })
  const sandboxId = `permissions-probe-${probeCase.id}-${Date.now()}`
  const contractSession = sandboxes.session(sandboxId)
  let marker: string | undefined
  const agent = buildAgent({
    probeCase,
    sandboxes,
    // The marker path is only knowable once the session has composed its own workdir.
    onSeed: (path) => {
      marker = path
    },
  })

  let session: ProbeSession | undefined
  try {
    await enableCorepack(contractSession, sandboxId)
    const expected = await kernelRelease(contractSession, `${WORK_DIR}/.expected-kernel`)
    log('control', `uname -r is ${JSON.stringify(expected)} in this container`)

    session = await agent.createSession({ sessionId: sandboxId })
    if (marker === undefined) {
      throw new Error('onSession never ran, so nothing was seeded and nothing can be read')
    }
    return await measure({ agent, session, contractSession, marker, expected })
  }
  finally {
    // The container exists from the moment `enableCorepack` acquires it, whether or not a
    // harness session was ever built on top, so both destroys are unconditional.
    await session?.destroy()
    await contractSession.destroy()
    log('cleanup', `${sandboxId} removed`)
  }
}

/** The turn itself, and the three readings taken off it. */
async function measure(input: {
  agent: ProbeAgent
  session: ProbeSession
  contractSession: SandboxSessionOf
  marker: string
  expected: string
}): Promise<CaseOutcome> {
  const result = await input.agent.generate({
    session: input.session,
    prompt: [
      `Run this exact shell command with the Bash tool: uname -r > ${input.marker}`,
      'Use the Bash tool and nothing else — do not create that file with any other tool.',
      'Then reply DONE, or, if the command was blocked, reply with the exact error text.',
    ].join('\n'),
  })

  const toolNames = result.steps.flatMap(step => step.toolCalls).map(call => call.toolName)
  const present = (await input.contractSession.exists(input.marker)).exists
  const content = present ? (await input.contractSession.readFile(input.marker)).content.trim() : ''

  return {
    // Existence is not enough: the file has to carry a string only an executed command
    // produces, so a marker written by some other tool cannot be counted as bash having run.
    bashRan: content === input.expected,
    bashCalls: toolNames.filter(name => name === 'bash').length,
    foreignWriteCalls: toolNames.filter(name => name === 'write' || name === 'edit').length,
    answer: (result.text ?? '').slice(0, 200),
  }
}

/** `ignored` / `bound` / `inconclusive` — the reading, separated from what it means. */
function verdictOf(outcome: CaseOutcome): 'ignored' | 'bound' | 'inconclusive' {
  if (outcome.bashRan) {
    return outcome.foreignWriteCalls > 0 && outcome.bashCalls === 0 ? 'inconclusive' : 'ignored'
  }
  return outcome.bashCalls > 0 ? 'bound' : 'inconclusive'
}

if (!await isDockerAvailable()) {
  log('SKIP', 'no Linux-container docker daemon is reachable')
  process.exit(0)
}
if (!CREDENTIALS.some(name => process.env[name])) {
  log('SKIP', `needs one of ${CREDENTIALS.join(', ')} in the environment`)
  process.exit(0)
}

const verdicts = new Map<string, 'ignored' | 'bound' | 'inconclusive'>()

for (const probeCase of CASES) {
  log('')
  log(`=== CASE ${probeCase.id}`, probeCase.title)
  log('adapter sends', probeCase.adapterPath)
  const outcome = await runCase(probeCase)
  const verdict = verdictOf(outcome)
  verdicts.set(probeCase.id, verdict)

  log('answer', JSON.stringify(outcome.answer))
  log('bash tool calls', String(outcome.bashCalls))
  log('write/edit tool calls', String(outcome.foreignWriteCalls))
  log(probeCase.seedDeny ? 'seeded deny rule' : 'bash without any deny rule', verdict)

  // Stop rather than spend two more containers on readings that could not be interpreted.
  if (!probeCase.seedDeny && verdict !== 'ignored') {
    log('')
    log('CONCLUSION', `VOID: the control did not run bash (${verdict}), so no deny can be read`)
    process.exit(1)
  }
}

log('')
log('=== VERDICT ===')
for (const probeCase of CASES) {
  log(`${probeCase.id.padEnd(9)}`, `${verdicts.get(probeCase.id)}  (${probeCase.adapterPath})`)
}

const readings = CASES.filter(probeCase => probeCase.seedDeny)
  .map(probeCase => verdicts.get(probeCase.id))
log('')
if (readings.includes('inconclusive')) {
  // A case where the agent never reached for bash measured nothing about permissions — the
  // run has to be repeated rather than read, so it must not exit 0 (cubic review, PR #7).
  log('CONCLUSION', 'INCONCLUSIVE: at least one case never attempted the command')
  process.exitCode = 1
}
else if (readings.every(reading => reading === 'ignored')) {
  log('CONCLUSION', 'a seeded deny rule binds on neither route — permissionMode is the only live source')
}
else if (readings.every(reading => reading === 'bound')) {
  log('CONCLUSION', 'a seeded deny rule binds on both routes — the settings file is a live second source')
}
else {
  log('CONCLUSION', 'the two routes disagree — which source wins depends on how the adapter is configured')
}
