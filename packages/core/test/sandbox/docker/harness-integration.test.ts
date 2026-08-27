/**
 * The two tiers, joined.
 *
 * `../harness` translates the contract into the AI SDK's `HarnessV1SandboxProvider` once, for
 * every backend; `../docker` implements the contract without knowing the harness exists. The
 * claim that makes the split worth its extra layer is that those two facts compose with no
 * glue in between — which is only true if a real backend, driven through the harness surface
 * rather than the contract's, behaves. That is what this file checks.
 *
 * Skips with no Linux-container daemon reachable.
 */
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createDockerSandbox, isDockerAvailable } from '../../../src/sandbox/docker'
import { createHarnessSandboxProvider } from '../../../src/sandbox/harness'
import { IMAGE_PULL_TIMEOUT_MS, pullSandboxImage, SANDBOX_IMAGE } from './image.fixtures'

const dockerAvailable = await isDockerAvailable()
const WORK_DIR = '/work'
const suite = dockerAvailable ? describe : describe.skip

suite('docker backend through the harness provider', () => {
  const sessionId = `harness-${crypto.randomUUID().slice(0, 8)}`
  let provider: HarnessV1SandboxProvider

  beforeAll(async () => {
    await pullSandboxImage()
    provider = createHarnessSandboxProvider({
      sandboxes: createDockerSandbox({
        image: SANDBOX_IMAGE,
        workDir: WORK_DIR,
        ports: [8080],
      }),
      defaultWorkingDirectory: WORK_DIR,
      ports: [8080],
    })
  }, IMAGE_PULL_TIMEOUT_MS)

  afterAll(async () => {
    if (dockerAvailable) {
      await provider.resumeSession?.({ sessionId }).then(async session => session.destroy())
    }
  })

  it('names the backend it was built over', () => {
    expect(provider.providerId).toBe('pleaseai-docker')
    expect(provider.specificationVersion).toBe('harness-sandbox-v1')
  })

  it('creates a session carrying the harness infra surface', async () => {
    const session = await provider.createSession({ sessionId })

    expect(session.id).toBe(sessionId)
    expect(session.defaultWorkingDirectory).toBe(WORK_DIR)
    expect(session.ports).toEqual([8080])
  })

  it('runs the framework setup hook exactly once, on creation', async () => {
    const marker = `${WORK_DIR}/bootstrapped`
    const oneShotId = `${sessionId}-hook`

    const session = await provider.createSession({
      sessionId: oneShotId,
      onFirstCreate: async created => created.writeTextFile({ path: marker, content: 'yes' }),
    })
    const read = await session.readTextFile({ path: marker })
    await session.destroy()

    expect(read).toBe('yes')
  })

  it('reads and writes text through the harness file surface', async () => {
    const session = await provider.resumeSession!({ sessionId })

    await session.writeTextFile({ path: `${WORK_DIR}/harness.txt`, content: 'through the tiers' })

    expect(await session.readTextFile({ path: `${WORK_DIR}/harness.txt` })).toBe('through the tiers')
  })

  it('resolves a missing file to null rather than throwing', async () => {
    const session = await provider.resumeSession!({ sessionId })

    expect(await session.readTextFile({ path: `${WORK_DIR}/never-written` })).toBeNull()
  })

  it('runs a command and reports its streams and exit code', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const result = await session.run({ command: 'echo out ; echo err >&2 ; exit 7' })

    expect(result.stdout.trim()).toBe('out')
    expect(result.stderr.trim()).toBe('err')
    expect(result.exitCode).toBe(7)
  })

  it('resolves relative commands against the session working directory', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const result = await session.run({ command: 'pwd' })

    // The framework composes each session's directory underneath the sandbox default, so the
    // path is expected to start there rather than to equal it.
    expect(result.stdout.trim().startsWith(WORK_DIR)).toBe(true)
  })

  it('spawns a long-running process whose streams can be read', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const proc = await session.spawn({ command: 'echo spawned' })
    const stdout = await new Response(proc.stdout).text()
    const { exitCode } = await proc.wait()

    expect(stdout).toContain('spawned')
    expect(exitCode).toBe(0)
  })

  it('resolves a dialable endpoint for the exposed port', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const endpoint = await session.getPortEndpoint({ port: 8080, protocol: 'ws' })

    expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
  })

  it('hands user tools a view that cannot stop the sandbox', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const restricted = session.restricted() as Record<string, unknown>

    expect(restricted.stop).toBeUndefined()
    expect(restricted.destroy).toBeUndefined()
    expect(typeof restricted.run).toBe('function')
  })

  it('destroys idempotently, as the harness requires', async () => {
    const throwawayId = `${sessionId}-throwaway`
    const session = await provider.createSession({ sessionId: throwawayId })

    await session.destroy()

    expect(session.destroy()).resolves.toBeUndefined()
  })
})
