/**
 * The two tiers, joined — over the backend that runs no processes at all.
 *
 * `../local`'s sibling of this file already checks that `../harness` composes with the contract
 * wherever the suite runs. This one checks the same claim where the backend underneath is
 * virtual: no pid to report, no live output to follow, and no port to dial. Those are exactly
 * the places a translation layer written against real processes would quietly assume otherwise,
 * so they are worth exercising through the harness rather than only through the contract.
 */
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHarnessSandboxProvider } from '../../../src/sandbox/harness'
import { createJustBashSandbox } from '../../../src/sandbox/just-bash'

describe('just-bash backend through the harness provider', () => {
  const sessionId = `harness-${crypto.randomUUID().slice(0, 8)}`
  const workDir = '/work'
  let provider: HarnessV1SandboxProvider

  beforeAll(() => {
    // `ports: []`, not a port: this backend answers `portEndpoint` with a named refusal, so
    // declaring one would advertise an endpoint the harness could never resolve. That is the
    // limit `../../../src/sandbox/just-bash/provider.ts` documents, asserted directly below.
    provider = createHarnessSandboxProvider({
      sandboxes: createJustBashSandbox({ workDir }),
      defaultWorkingDirectory: workDir,
      ports: [],
    })
  })

  afterAll(async () => {
    await provider.resumeSession?.({ sessionId }).then(async session => session.destroy())
  })

  it('names the backend it was built over', () => {
    expect(provider.providerId).toBe('pleasedev-just-bash')
    expect(provider.specificationVersion).toBe('harness-sandbox-v1')
  })

  it('creates a session carrying the harness infra surface', async () => {
    const session = await provider.createSession({ sessionId })

    expect(session.id).toBe(sessionId)
    expect(session.defaultWorkingDirectory).toBe(workDir)
    expect(session.ports).toEqual([])
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

  it('spawns a process whose streams can be read, coalesced though they are', async () => {
    const session = await provider.resumeSession!({ sessionId })

    const proc = await session.spawn({ command: 'echo spawned' })
    const stdout = await new Response(proc.stdout).text()
    const { exitCode } = await proc.wait()

    expect(stdout).toContain('spawned')
    expect(exitCode).toBe(0)
  })

  it('refuses a port endpoint through the harness too, rather than inventing one', async () => {
    const session = await provider.resumeSession!({ sessionId })

    await expect(session.getPortEndpoint({ port: 8080, protocol: 'http' })).rejects.toThrow(/port/)
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
