import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'
import type { SandboxDefinition } from '../../src/sandbox'
import type { FakeSandboxOptions, FakeSandboxState } from '../sandbox/harness/sandbox.fixtures'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { defineAgent } from '../../src/agent/define'
import { fakeSandboxProvider } from '../sandbox/harness/sandbox.fixtures'

/**
 * A harness adapter that starts a session and does nothing else.
 *
 * `defineAgent` builds a real `HarnessAgent` around whatever adapter it is handed, so the
 * adapter is the seam that keeps a session test off a runtime: with no `getBootstrap` there is
 * no recipe to apply, and `doStart` is the last call `createSession` makes. Everything the
 * turn surface needs is absent because no test here takes a turn — `prompt` is the AI SDK's
 * own path, and driving it would be a test of the SDK.
 */
function fakeHarness(options: { startRejects?: unknown } = {}): {
  adapter: HarnessAgentAdapter
  starts: { sessionId: string, sessionWorkDir: string }[]
  destroys: number
} {
  const record = {
    starts: [] as { sessionId: string, sessionWorkDir: string }[],
    destroys: 0,
  }
  const adapter = {
    specificationVersion: 'harness-v1',
    harnessId: 'fake',
    builtinTools: {},
    doStart: ({ sessionId, sessionWorkDir }: { sessionId: string, sessionWorkDir: string }) => {
      if (options.startRejects !== undefined) {
        return Promise.reject(options.startRejects)
      }
      record.starts.push({ sessionId, sessionWorkDir })
      return Promise.resolve({
        sessionId,
        isResume: false,
        doDestroy: () => {
          record.destroys += 1
          return Promise.resolve()
        },
      })
    },
  }
  return {
    // The adapter surface is a dozen turn methods this fake has no use for; the cast is what
    // keeps the fake to the three calls `createSession` and `close` actually make.
    adapter: adapter as unknown as HarnessAgentAdapter,
    get starts() {
      return record.starts
    },
    get destroys() {
      return record.destroys
    },
  }
}

/** A sandbox definition over the in-memory contract fake the harness suite already uses. */
function fakeSandbox(
  definition: Omit<SandboxDefinition, 'backend'> = {},
  options: FakeSandboxOptions = {},
): { sandbox: SandboxDefinition, state: FakeSandboxState } {
  const { provider, state } = fakeSandboxProvider(options)
  return { sandbox: { ...definition, backend: () => provider }, state }
}

/** The directory a session lands in: the default work dir, then `<harnessId>-<sessionId>`. */
function sessionWorkDir(sessionId: string): string {
  return `/work/fake-${sessionId}`
}

describe('defineAgent', () => {
  it('exposes the session id and the directory the session actually landed in', async () => {
    const harness = fakeHarness()
    const { sandbox } = fakeSandbox()
    const session = await defineAgent({ harness: harness.adapter, sandbox })
      .createSession({ sessionId: 'probe' })

    expect(session.sessionId).toBe('probe')
    // Not the definition's `workDir`: sessions get their own directory underneath it, and the
    // one that matters to a caller reading a file back is the one `onSession` reported.
    expect(session.workDir).toBe(sessionWorkDir('probe'))
    expect(harness.starts).toEqual([{ sessionId: 'probe', sessionWorkDir: sessionWorkDir('probe') }])
  })

  it('seeds the workspace before the definition\'s own onSession hook runs', async () => {
    const seen: string[] = []
    const { sandbox, state } = fakeSandbox({
      onSession: async ({ session, sessionWorkDir: dir }) => {
        seen.push(...state.writes.map(write => write.path))
        await session.writeTextFile({ path: `${dir}/CLAUDE.md`, content: '# overwritten\n' })
      },
    })

    await defineAgent({
      harness: fakeHarness().adapter,
      sandbox,
      workspace: { 'CLAUDE.md': '# seeded\n' },
    }).createSession({ sessionId: 'probe' })

    // The ordering is the behaviour: the hook runs last so that a definition can overwrite
    // what the workspace seeded, rather than being overwritten by it.
    expect(seen).toEqual([`${sessionWorkDir('probe')}/CLAUDE.md`])
    expect(new TextDecoder().decode(state.files('probe').get(`${sessionWorkDir('probe')}/CLAUDE.md`)))
      .toBe('# overwritten\n')
  })

  it('resolves a relative read against the session directory and passes an absolute one through', async () => {
    const { sandbox, state } = fakeSandbox()
    const agent = defineAgent({
      harness: fakeHarness().adapter,
      sandbox,
      workspace: { 'notes/answer.txt': '42\n' },
    })
    const session = await agent.createSession({ sessionId: 'probe' })
    state.files('probe').set('/etc/probe', new TextEncoder().encode('absolute\n'))

    expect(await session.readTextFile('notes/answer.txt')).toBe('42\n')
    expect(await session.readTextFile('/etc/probe')).toBe('absolute\n')
  })

  it('tears the session down and removes the sandbox behind it', async () => {
    const harness = fakeHarness()
    const { sandbox, state } = fakeSandbox()
    const session = await defineAgent({ harness: harness.adapter, sandbox })
      .createSession({ sessionId: 'probe' })

    await session.close()

    expect(harness.destroys).toBe(1)
    expect(state.destroys).toBeGreaterThan(0)
  })
})

describe('defineAgent session failures', () => {
  it('reaps the container when onCreate rejects, and reports the original cause', async () => {
    const boom = new Error('corepack enable failed')
    const { sandbox, state } = fakeSandbox({ onCreate: () => Promise.reject(boom) })

    // `onCreate` acquires the container — the call that runs the hook is what starts it — so a
    // hook that then rejects leaves one running behind a `createSession` that never returned a
    // handle to reap it. Nothing else holds one; the destroy here is the only reaper.
    await expect(defineAgent({ harness: fakeHarness().adapter, sandbox }).createSession())
      .rejects
      .toThrow(boom)
    expect(state.destroys).toBe(1)
  })

  it('leaves a container it did not create alone, even when onCreate rejects', async () => {
    const boom = new Error('corepack enable failed')
    const { sandbox, state } = fakeSandbox({ onCreate: () => Promise.reject(boom) })

    // The contrast with the test above, and the whole reason the reap is conditional: a
    // caller-supplied id may name a container that already existed — `docker/container.ts`
    // adopts one rather than failing — so this call did not create it, and destroying it would
    // throw away the state the caller named it to get back to. Only a generated id is ours.
    await expect(
      defineAgent({ harness: fakeHarness().adapter, sandbox }).createSession({ sessionId: 'adopted' }),
    ).rejects.toThrow(boom)
    expect(state.destroys).toBe(0)
  })

  it('reaps the container when the harness session itself fails to start', async () => {
    const boom = new Error('bridge never came up')
    // The harness makes its own best-effort teardown attempt and swallows whatever it gets, so
    // a transient failure there leaves the container running with nothing left holding a
    // handle. `createSession`'s own destroy is what retries it: the first reaches the backend
    // and fails, the second lands.
    const { sandbox, state } = fakeSandbox({}, { failingDestroys: 1 })

    await expect(
      defineAgent({ harness: fakeHarness({ startRejects: boom }).adapter, sandbox }).createSession(),
    ).rejects.toThrow(boom)
    expect(state.destroys).toBe(2)
  })

  it('does not let a failed workspace read poison every later session', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'please-agent-')), 'workspace')
    const { sandbox, state } = fakeSandbox()
    const agent = defineAgent({ harness: fakeHarness().adapter, sandbox, workspace: root })

    // The read is memoised so that several sessions do not walk the host filesystem again for
    // the same directory — but a rejected promise left in that latch would be replayed by
    // every later session without ever touching the filesystem again, so one transient failure
    // would make the agent permanently unable to seed.
    await expect(agent.createSession({ sessionId: 'first' })).rejects.toThrow()

    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'CLAUDE.md'), '# conventions\n')
    await agent.createSession({ sessionId: 'second' })

    expect(state.writes.map(write => write.path))
      .toEqual([`${sessionWorkDir('second')}/CLAUDE.md`])
  })
})
