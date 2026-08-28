/**
 * The local backend against the real host.
 *
 * These are integration tests, not unit tests, for the reason `../docker/backend.test.ts`
 * gives: the backend's whole job is to make a directory and a detached shell behave like the
 * contract, and a mocked `Bun.spawn` would only assert that the argv matches what this code
 * already builds. What is actually in question — whether a `detached` wrapper really leads its
 * own process group, whether a polled follow ends when the process does, whether a journal
 * survives being read by a provider that never started the command — is only answerable
 * against real processes.
 *
 * Unlike the Docker suite, nothing here skips: there is no daemon to be missing. The one
 * platform assumption is POSIX — process groups, `sh`, and signals.
 */
import type { ProcessLogCursor, ProcessLogEvent, SandboxProvider } from '../../../src/sandbox/contract'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '../../../src/sandbox/contract'
import { createLocalSandbox, sandboxDirName } from '../../../src/sandbox/local'

const suite = process.platform === 'win32' ? describe.skip : describe

/** Collect a log stream into per-stream text, keeping the last cursor it reported. */
async function drain(events: ReadableStream<ProcessLogEvent>) {
  const decoder = new TextDecoder()
  const out: string[] = []
  const err: string[] = []
  let terminal: ProcessLogEvent | undefined
  let cursor: ProcessLogCursor | undefined

  for await (const event of events) {
    if (event.cursor !== undefined) {
      cursor = event.cursor
    }
    if (event.type === 'stdout') {
      out.push(decoder.decode(event.data))
    }
    else if (event.type === 'stderr') {
      err.push(decoder.decode(event.data))
    }
    else if (event.type === 'terminal') {
      terminal = event
    }
  }

  return { stdout: out.join(''), stderr: err.join(''), terminal, cursor }
}

/** Whether a path exists on the host, directories included. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/** Whether a pid the host can see is still running. */
function hostProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

suite('local sandbox backend', () => {
  const sandboxId = `spec-${crypto.randomUUID().slice(0, 8)}`
  let root: string
  let sandboxes: SandboxProvider

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'please-local-'))
    sandboxes = createLocalSandbox({ root })
  })

  afterAll(async () => {
    await sandboxes.session(sandboxId).destroy()
    await rm(root, { recursive: true, force: true })
  })

  it('reports its backend name', () => {
    expect(sandboxes.backend).toBe('local')
  })

  it('creates the sandbox directory lazily, on the first call that needs it', async () => {
    const lazyId = `lazy-${crypto.randomUUID().slice(0, 8)}`
    const session = sandboxes.session(lazyId)

    // Resolving a session touches no filesystem; this is the call that creates the tree.
    expect(await session.listProcesses()).toEqual([])
    const probe = await session.exists('.')
    await session.destroy()

    expect(probe.exists).toBe(true)
  })

  it('round-trips a text file', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile('nested/hello.txt', 'hello sandbox')
    const read = await session.readFile('nested/hello.txt')

    expect(read.content).toBe('hello sandbox')
  })

  it('resolves a relative path against the sandbox working directory', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile('relative.txt', 'resolved')
    const proc = await session.exec(['cat', 'relative.txt'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout).toBe('resolved')
  })

  it('creates missing parent directories on write', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile('a/b/c/deep.txt', 'deep')

    expect((await session.exists('a/b/c/deep.txt')).exists).toBe(true)
  })

  it('round-trips bytes that are not valid UTF-8, through base64', async () => {
    const session = sandboxes.session(sandboxId)
    const bytes = Buffer.from([0x00, 0xFF, 0xFE, 0x01]).toString('base64')

    await session.writeFile('raw.bin', bytes, { encoding: 'base64' })
    const read = await session.readFile('raw.bin', { encoding: 'base64' })

    expect(read.content).toBe(bytes)
  })

  it('streams a read when the caller asks for no encoding', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile('streamed.txt', 'by the chunk')
    const streamed = await session.readFile('streamed.txt', { encoding: 'none' })

    expect(await new Response(streamed.content).text()).toBe('by the chunk')
  })

  it('rejects a read of a path that does not exist', async () => {
    const session = sandboxes.session(sandboxId)

    await expect(session.readFile('absent')).rejects.toThrow()
  })

  it('reports a missing path as absent rather than throwing', async () => {
    const session = sandboxes.session(sandboxId)

    expect((await session.exists('absent')).exists).toBe(false)
  })

  it('reports a directory as existing, not only a file', async () => {
    const session = sandboxes.session(sandboxId)

    await session.mkdir('a-directory', { recursive: true })

    expect((await session.exists('a-directory')).exists).toBe(true)
  })

  it('runs a command and journals its exit code', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'exit 3'])
    const exit = await proc.waitForExit()

    expect(exit.code).toBe(3)
    expect(exit.timedOut).toBe(false)
  })

  it('keeps stdout and stderr apart', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo to-out ; echo to-err >&2'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('to-out')
    expect(logs.stderr.trim()).toBe('to-err')
  })

  it('replays a process log after the process has exited', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo durable'])
    await proc.waitForExit()

    const recovered = await session.getProcess(proc.id)
    expect(recovered).not.toBeNull()
    const logs = await drain(await recovered!.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('durable')
  })

  it('reads a process back through a provider that never started it', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo across processes'])
    await proc.waitForExit()

    // The durability the contract is built on, and the reason commands are journalled to disk
    // rather than held as child handles: a second provider over the same root shares nothing
    // in memory with the one that ran the command, which is the position a later host process
    // is in after a restart.
    const cold = createLocalSandbox({ root })
    const recovered = await cold.session(sandboxId).getProcess(proc.id)

    expect(recovered).not.toBeNull()
    expect((await recovered!.status()).state).toBe('exited')
    expect((await drain(await recovered!.logs({ replay: true }))).stdout.trim())
      .toBe('across processes')
  })

  it('follows a running process and ends when it does', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo first ; sleep 1 ; echo second'])
    const logs = await drain(await proc.logs({ replay: true, follow: true }))

    expect(logs.stdout).toContain('first')
    expect(logs.stdout).toContain('second')
    expect(logs.terminal?.type).toBe('terminal')
  })

  it('resumes from a cursor rather than replaying what the caller already folded in', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo one ; sleep 0.6 ; echo two'])
    // Read the first line only, while the process is still between its two writes.
    await Bun.sleep(200)
    const first = await drain(await proc.logs({ replay: true }))
    await proc.waitForExit()
    const rest = await drain(await proc.logs({ since: first.cursor! }))

    expect(first.stdout).toContain('one')
    expect(rest.stdout).not.toContain('one')
    expect(rest.stdout).toContain('two')
  }, 20_000)

  it('reports a running process as running, and an exited one as exited', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sleep', '30'])
    const running = await proc.status()
    await proc.kill()
    await proc.waitForExit()
    const finished = await proc.status()

    expect(running.state).toBe('running')
    expect(finished.state).toBe('exited')
  })

  it('kills the process group, so a child does not outlive its parent', async () => {
    const session = sandboxes.session(sandboxId)

    // The grandchild publishes its own pid, because the wrapper's exit code only ever
    // describes the wrapper's direct child — a group kill that missed the `sleep` would leave
    // it running behind an exit code that looked perfectly correct. It is checked from the
    // host, which is the strongest form of this assertion available: a real init reaps, so an
    // answer of "gone" here is not a zombie the way it would be inside a container.
    const proc = await session.exec(['sh', '-c', 'sleep 60 & echo $! > grandchild.pid ; wait'])
    const deadline = Date.now() + 10_000
    while (!(await session.exists('grandchild.pid')).exists) {
      expect(Date.now(), 'grandchild never published its pid').toBeLessThan(deadline)
      await Bun.sleep(20)
    }
    const grandchild = Number.parseInt((await session.readFile('grandchild.pid')).content, 10)
    expect(hostProcessAlive(grandchild)).toBe(true)

    await proc.kill()
    const exit = await proc.waitForExit()

    expect(hostProcessAlive(grandchild)).toBe(false)
    // The shell reports a signalled child as 128 + signal; SIGTERM is 15.
    expect(exit.code).toBe(143)
    expect(exit.signal).toBe(15)
  }, 20_000)

  it('rejects a wait that expires before the process does', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sleep', '30'])
    const wait = proc.waitForExit({ timeout: 300 })

    await expect(wait).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
    await proc.kill()
  })

  it('lists the processes it has run', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['true'])
    await proc.waitForExit()
    const listed = await session.listProcesses()

    expect(listed.map(entry => entry.id)).toContain(proc.id)
  })

  it('answers null for a process id it never ran', async () => {
    const session = sandboxes.session(sandboxId)

    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
  })

  it('answers cold rather than creating a directory when a sandbox was never started', async () => {
    const coldId = `cold-${crypto.randomUUID().slice(0, 8)}`
    const session = sandboxes.session(coldId)

    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
    expect(await session.listProcesses()).toEqual([])
    // The discovery calls must not have brought the sandbox into being as a side effect.
    expect(await pathExists(join(root, sandboxDirName(coldId)))).toBe(false)
  })

  it('passes cwd and env through to the process', async () => {
    const session = sandboxes.session(sandboxId)

    await session.mkdir('cwd-probe', { recursive: true })
    const proc = await session.exec(['sh', '-c', 'pwd ; echo "$PROBE"'], {
      cwd: 'cwd-probe',
      env: { PROBE: 'passed-through' },
    })
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout).toContain('cwd-probe')
    expect(logs.stdout).toContain('passed-through')
  })

  it('does not declare IS_SANDBOX, because running on the host is not a sandbox', async () => {
    const session = sandboxes.session(sandboxId)

    // The inverse of the Docker backend's claim, and deliberately. `IS_SANDBOX=1` is what lets
    // the Claude Code CLI skip its refusal to bypass permissions as root; asserting it here
    // would defeat that check on a developer's own machine, where it is the only one left.
    const proc = await session.exec(['sh', '-c', 'echo "[$IS_SANDBOX]"'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('[]')
  })

  it('withholds host variables the allowlist does not name', async () => {
    const secretName = `PLEASE_SPEC_SECRET_${crypto.randomUUID().slice(0, 8)}`
    process.env[secretName] = 'must-not-leak'
    try {
      const session = createLocalSandbox({ root }).session(sandboxId)

      const proc = await session.exec(['sh', '-c', `echo "[$${secretName}]"`])
      await proc.waitForExit()
      const logs = await drain(await proc.logs({ replay: true }))

      expect(logs.stdout.trim()).toBe('[]')
    }
    finally {
      delete process.env[secretName]
    }
  })

  it('passes a host variable through when the caller opts into it by name', async () => {
    const session = createLocalSandbox({ root, env: { PROBE: 'opted-in' } }).session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo "$PROBE"'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('opted-in')
  })

  it('inherits PATH, so a command is found without the caller supplying one', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo "$PATH"'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim().length).toBeGreaterThan(0)
  })

  it('hands argv to the process without a shell reinterpreting it', async () => {
    const session = sandboxes.session(sandboxId)
    const hostile = 'x\'y $(echo pwned) `echo pwned` *'

    // A stronger claim than the Docker backend's, which quotes argv into a script string. Here
    // the argv travels beside the wrapper as positional parameters, so there is no quoting step
    // that could be wrong in the first place.
    const proc = await session.exec(['echo', hostile])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe(hostile)
  })

  it('terminates a process that outruns its own timeout', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sleep', '30'], { timeout: 1000 })
    const exit = await proc.waitForExit()

    // `timedOut` comes from the marker the watchdog writes before it fires, not from the exit
    // code — it is the contract's way of saying the process died of its own timeout rather
    // than because a caller stopped waiting.
    expect(exit.timedOut).toBe(true)
    expect(exit.code).toBe(143)
    expect(exit.signal).toBe(15)
  }, 20_000)

  it('forces down a command that ignores SIGTERM once its timeout grace expires', async () => {
    const session = sandboxes.session(sandboxId)

    // The only test that reaches the escalation. Every other timeout test uses a command that
    // dies of the watchdog's `SIGTERM` and so stops one step short of the branch that waits out
    // the grace period and force-kills the group. A regression here means a command that
    // ignores `SIGTERM` outlives its timeout and the wrapper's wait loop never ends.
    const proc = await session.exec(
      ['sh', '-c', 'trap \'\' TERM ; while : ; do sleep 0.2 ; done'],
      { timeout: 300 },
    )
    const exit = await proc.waitForExit({ timeout: 30_000 })

    // 137 is `128 + 9`, and the `signal` record is what proves the 9 rather than a command that
    // merely returned 137 — the two are indistinguishable from the exit code alone.
    expect(exit.timedOut).toBe(true)
    expect(exit.code).toBe(137)
    expect(exit.signal).toBe(9)
  }, 40_000)

  it('does not mark an ordinary exit as timed out', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['true'])
    const exit = await proc.waitForExit()

    expect(exit.timedOut).toBe(false)
  })

  it('does not mark a command that returns 124 by itself as timed out', async () => {
    const session = sandboxes.session(sandboxId)

    // 124 is GNU `timeout`'s code for a command it terminated, and equally a code a command may
    // return on its own. Inferring the timeout from it confuses the two.
    const proc = await session.exec(['sh', '-c', 'exit 124'], { timeout: 30_000 })
    const exit = await proc.waitForExit()

    expect(exit.code).toBe(124)
    expect(exit.timedOut).toBe(false)
  })

  it('reports no signal for a command that returns a code above 128 by itself', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'exit 200'])
    const exit = await proc.waitForExit()

    expect(exit.code).toBe(200)
    expect(exit.signal).toBeUndefined()
  })

  it('resolves a loopback endpoint for a port, since the port is the host\'s own', async () => {
    const endpoint = await sandboxes.portEndpoint(sandboxId, 8080, { protocol: 'ws' })

    expect(endpoint.url).toBe('ws://127.0.0.1:8080')
  })

  it('reports a vanished process as having journalled no exit', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sleep', '30'])
    // SIGKILL leaves the wrapper no chance to write its exit line, which is exactly the state
    // the contract requires be reported as a rejection rather than a synthetic exit.
    await proc.kill(9)

    await expect(proc.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })

  it('destroys the sandbox directory and nothing outside it', async () => {
    const doomedId = `doomed-${crypto.randomUUID().slice(0, 8)}`
    const session = sandboxes.session(doomedId)
    await session.writeFile('inside.txt', 'gone soon')
    const neighbour = sandboxes.session(sandboxId)

    await session.destroy()

    expect((await session.exists('inside.txt')).exists).toBe(false)
    // The sibling sandbox and the shared root survive: `destroy()` is scoped to one directory.
    expect((await neighbour.exists('nested/hello.txt')).exists).toBe(true)
  })

  it('destroys idempotently', async () => {
    const session = sandboxes.session(`twice-${crypto.randomUUID().slice(0, 8)}`)
    await session.exists('.')

    await session.destroy()

    expect(session.destroy()).resolves.toBeUndefined()
  })
})
