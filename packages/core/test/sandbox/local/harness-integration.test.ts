/**
 * The two tiers, joined — over the backend that needs nothing installed.
 *
 * `../harness` translates the contract into the AI SDK's `HarnessV1SandboxProvider` once, for
 * every backend; `../local` implements the contract without knowing the harness exists. The
 * claim that makes the split worth its extra layer is that those two facts compose with no glue
 * in between, and the Docker suite can only check it where a daemon is reachable. This file
 * checks the same claim everywhere, which is the point of having a backend with no prerequisites.
 */
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHarnessSandboxProvider } from '../../../src/sandbox/harness'
import { createLocalSandbox } from '../../../src/sandbox/local'

const suite = process.platform === 'win32' ? describe.skip : describe

suite('local backend through the harness provider', () => {
  const sessionId = `harness-${crypto.randomUUID().slice(0, 8)}`
  let root: string
  let workDir: string
  let provider: HarnessV1SandboxProvider

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'please-local-harness-'))
    // The harness requires a working directory it can name, and the contract has no call that
    // reports the backend's own. For this backend it is the sandbox's `work/` directory, which
    // is also what a relative path resolves against — so a relative one is what it is given.
    workDir = '.'
    provider = createHarnessSandboxProvider({
      sandboxes: createLocalSandbox({ root }),
      defaultWorkingDirectory: workDir,
      ports: [8080],
    })
  })

  afterAll(async () => {
    await provider.resumeSession?.({ sessionId }).then(async session => session.destroy())
    await rm(root, { recursive: true, force: true })
  })

  it('names the backend it was built over', () => {
    expect(provider.providerId).toBe('pleaseai-local')
    expect(provider.specificationVersion).toBe('harness-sandbox-v1')
  })

  it('creates a session carrying the harness infra surface', async () => {
    const session = await provider.createSession({ sessionId })

    expect(session.id).toBe(sessionId)
    expect(session.defaultWorkingDirectory).toBe(workDir)
    expect(session.ports).toEqual([8080])
  })

  it('runs the framework setup hook exactly once, on creation', async () => {
    const oneShotId = `${sessionId}-hook`

    const session = await provider.createSession({
      sessionId: oneShotId,
      onFirstCreate: async created =>
        created.writeTextFile({ path: 'bootstrapped', content: 'yes' }),
    })
    const read = await session.readTextFile({ path: 'bootstrapped' })
    await session.destroy()

    expect(read).toBe('yes')
  })

  it('reads and writes text through the harness file surface', async () => {
    const session = await provider.resumeSession!({ sessionId })

    await session.writeTextFile({ path: 'harness.txt', content: 'through the tiers' })

    expect(await session.readTextFile({ path: 'harness.txt' })).toBe('through the tiers')
  })

  it('resolves a missing file to null rather than throwing', async () => {
    const session = await provider.resumeSession!({ sessionId })

    expect(await session.readTextFile({ path: 'never-written' })).toBeNull()
  })

  it('runs a command and reports its streams and exit code', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const result = await session.run({ command: 'echo out ; echo err >&2 ; exit 7' })

    expect(result.stdout.trim()).toBe('out')
    expect(result.stderr.trim()).toBe('err')
    expect(result.exitCode).toBe(7)
  })

  it('spawns a long-running process whose streams can be read', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const proc = await session.spawn({ command: 'echo spawned' })
    const stdout = await new Response(proc.stdout).text()
    const { exitCode } = await proc.wait()

    expect(stdout).toContain('spawned')
    expect(exitCode).toBe(0)
  })

  it('resolves a dialable endpoint for the declared port', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const endpoint = await session.getPortEndpoint({ port: 8080, protocol: 'ws' })

    expect(endpoint.url).toBe('ws://127.0.0.1:8080')
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

    await expect(session.destroy()).resolves.toBeUndefined()
  })
})
