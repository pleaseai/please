/**
 * Does the Claude Code adapter's own bootstrap run inside our Docker sandbox?
 *
 * This is the question the whole backend exists to answer, and it needs no credentials: the
 * adapter's recipe writes its bridge assets into the sandbox, runs
 * `pnpm install --frozen-lockfile`, and then proves the install by running `claude --version`.
 * If that completes, a container produced by `createDockerSandbox` satisfies what a
 * bridge-backed harness requires of a sandbox — real processes, a real filesystem, and
 * network egress to the registry.
 *
 * Run directly:  bun run scripts/probe-adapter-bootstrap.ts
 */
import process from 'node:process'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { prepareSandboxForHarness } from '@ai-sdk/harness/agent'
import { createDockerSandbox, isDockerAvailable } from '../src/sandbox/docker'
import { createHarnessSandboxProvider } from '../src/sandbox/harness'

const IMAGE = process.env.PROBE_IMAGE ?? 'node:22-bookworm'
const WORK_DIR = '/work'
const SESSION_ID = `bootstrap-probe-${Date.now()}`

function log(step: string, detail = ''): void {
  process.stdout.write(`${step}${detail === '' ? '' : `  ${detail}`}\n`)
}

if (!await isDockerAvailable()) {
  log('SKIP', 'no Linux-container docker daemon is reachable')
  process.exit(0)
}

const sandboxes = createDockerSandbox({ image: IMAGE, workDir: WORK_DIR, ports: [8080] })
const provider = createHarnessSandboxProvider({
  sandboxes,
  defaultWorkingDirectory: WORK_DIR,
  ports: [8080],
})

const startedAt = Date.now()
const session = await provider.createSession({ sessionId: SESSION_ID })

try {
  log('container', `${IMAGE} up as ${SESSION_ID}`)

  // The adapter's recipe runs `pnpm`, which the official node images ship only through
  // corepack. Enabling it is the image's business, not the harness's — a purpose-built image
  // would have pnpm on PATH already.
  const corepack = await session.run({ command: 'corepack enable pnpm && pnpm --version' })
  log('pnpm', corepack.exitCode === 0 ? corepack.stdout.trim() : `FAILED: ${corepack.stderr}`)
  if (corepack.exitCode !== 0) {
    process.exit(1)
  }

  const node = await session.run({ command: 'node --version' })
  log('node', node.stdout.trim())

  log('bootstrap', 'running the Claude Code adapter recipe (pnpm install + claude --version)')
  const prepared = await prepareSandboxForHarness({
    session: session.restricted(),
    harnesses: [createClaudeCode()],
  })

  log('RESULT', 'the adapter bootstrapped cleanly inside the sandbox')
  log('detail', JSON.stringify(prepared, null, 2).slice(0, 400))

  const installed = await session.run({
    command: './node_modules/.bin/claude --version',
    workingDirectory: `${WORK_DIR}/.harness-bootstrap/claude-code`,
  })
  log('claude', installed.exitCode === 0 ? installed.stdout.trim() : `absent: ${installed.stderr.trim()}`)
  log('elapsed', `${Math.round((Date.now() - startedAt) / 1000)}s`)
}
finally {
  await session.destroy()
  log('cleanup', 'container removed')
}
