/**
 * The just-bash backend against the real interpreter.
 *
 * Integration tests in the same sense as the other two suites — the backend's job is to make a
 * vendor object behave like the contract, and a mocked `just-bash` would only assert that the
 * arguments match what this code already builds. Nothing skips: the interpreter needs no daemon,
 * no image and no particular platform, which is the whole point of this backend.
 *
 * Several tests here pin *limits* rather than capabilities. They are not aspirational — a
 * regression that made `git` resolve, or `portEndpoint` answer, would mean the backend had
 * started lying about what it is.
 */
import type { ProcessLogEvent, SandboxProvider } from '../../../src/sandbox/contract'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  SandboxFileNotFoundError,
  SandboxWaitTimeoutError,
} from '../../../src/sandbox/contract'
import {
  createJustBashSandbox,
  JustBashBinaryUnsupportedError,
  JustBashEnvNameError,
  JustBashPortsUnavailableError,
} from '../../../src/sandbox/just-bash'

const WORK_DIR = '/work'

/** Collect a log stream into per-stream text, keeping the last cursor it reported. */
async function drain(events: ReadableStream<ProcessLogEvent>) {
  const decoder = new TextDecoder()
  const out: string[] = []
  const err: string[] = []
  let terminal: ProcessLogEvent | undefined
  let cursor: string | undefined

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

/** A provider and a sandbox id of its own, so no test inherits another's filesystem. */
function freshSandbox(): { sandboxes: SandboxProvider, sandboxId: string } {
  return {
    sandboxes: createJustBashSandbox({ workDir: WORK_DIR }),
    sandboxId: `spec-${crypto.randomUUID().slice(0, 8)}`,
  }
}

describe('just-bash sandbox backend', () => {
  it('reports its backend name', () => {
    expect(createJustBashSandbox().backend).toBe('just-bash')
  })

  it('creates the interpreter lazily, on the first call that needs it', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    // Resolving a session creates nothing; discovery answers cold rather than standing one up.
    expect(await session.listProcesses()).toEqual([])
    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
  })

  it('round-trips a text file', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    await session.writeFile('nested/hello.txt', 'hello sandbox')

    expect((await session.readFile('nested/hello.txt')).content).toBe('hello sandbox')
  })

  it('resolves a relative path against the sandbox working directory', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    await session.writeFile('relative.txt', 'resolved')
    const proc = await session.exec(['cat', `${WORK_DIR}/relative.txt`])
    await proc.waitForExit()

    expect((await drain(await proc.logs({ replay: true }))).stdout).toBe('resolved')
  })

  it('round-trips base64 whose bytes are valid UTF-8', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    const bytes = Buffer.from('héllo — ünicode\n', 'utf8').toString('base64')

    await session.writeFile('text.b64', bytes, { encoding: 'base64' })

    expect((await session.readFile('text.b64', { encoding: 'base64' })).content).toBe(bytes)
  })

  it('refuses a write whose bytes it could only store corrupted', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    const binary = Buffer.from([0x00, 0xFF, 0xFE, 0x01]).toString('base64')

    // Measured: the vendor stores these four bytes as eight, substituting U+FFFD, and `wc -c`
    // inside the sandbox agrees with the corrupted length. Refusing beats corrupting silently.
    await expect(session.writeFile('raw.bin', binary, { encoding: 'base64' }))
      .rejects
      .toBeInstanceOf(JustBashBinaryUnsupportedError)
    expect((await session.exists('raw.bin')).exists).toBe(false)
  })

  it('refuses a streamed write of the same bytes, not only a base64 one', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    const stream = new Response(new Uint8Array([0x00, 0xFF, 0xFE, 0x01])).body!

    await expect(session.writeFile('raw.bin', stream))
      .rejects
      .toBeInstanceOf(JustBashBinaryUnsupportedError)
  })

  it('streams a read when the caller asks for no encoding', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    await session.writeFile('streamed.txt', 'by the chunk')
    const streamed = await session.readFile('streamed.txt', { encoding: 'none' })

    expect(await new Response(streamed.content).text()).toBe('by the chunk')
  })

  it('rejects a read of a path that does not exist, with the contract\'s own class', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    await expect(session.readFile('absent')).rejects.toBeInstanceOf(SandboxFileNotFoundError)
  })

  it('reports a directory as existing, not only a file', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    await session.mkdir('a-directory', { recursive: true })

    expect((await session.exists('a-directory')).exists).toBe(true)
    expect((await session.exists('absent')).exists).toBe(false)
  })

  it('runs a command and reports its exit code', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const exit = await (await session.exec(['sh', '-c', 'exit 3'])).waitForExit()

    expect(exit.code).toBe(3)
    expect(exit.timedOut).toBe(false)
  })

  it('keeps stdout and stderr apart', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo to-out ; echo to-err >&2'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('to-out')
    expect(logs.stderr.trim()).toBe('to-err')
  })

  it('replays a process log after the process has exited', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo durable'])
    await proc.waitForExit()
    const recovered = await session.getProcess(proc.id)

    expect(recovered).not.toBeNull()
    expect((await drain(await recovered!.logs({ replay: true }))).stdout.trim()).toBe('durable')
  })

  it('reads a process back through a second session over the same sandbox id', async () => {
    const { sandboxes, sandboxId } = freshSandbox()

    // `SandboxProvider.session` is called per use rather than held across a workflow step, so a
    // registry owned by one session object would answer `null` for every process the previous
    // call started.
    const proc = await sandboxes.session(sandboxId).exec(['sh', '-c', 'echo across sessions'])
    await proc.waitForExit()

    expect(await sandboxes.session(sandboxId).getProcess(proc.id)).not.toBeNull()
    expect((await sandboxes.session(sandboxId).listProcesses()).map(entry => entry.id))
      .toContain(proc.id)
  })

  it('resumes from a cursor rather than replaying what the caller already folded in', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo on-out ; echo on-err >&2'])
    await proc.waitForExit()
    const first = await drain(await proc.logs({ replay: true }))
    const rest = await drain(await proc.logs({ since: '1' }))

    expect(first.stdout).toContain('on-out')
    expect(first.stderr).toContain('on-err')
    // The vendor coalesces a command's output into one message per stream, so the cursor moves
    // in units of streams here rather than bytes. Skipping the first drops all of stdout.
    expect(rest.stdout).toBe('')
    expect(rest.stderr).toContain('on-err')
  })

  it('reports a running process as running, and an exited one as exited', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 2'])
    const running = await proc.status()
    await proc.kill()
    await proc.waitForExit()

    expect(running.state).toBe('running')
    expect((await proc.status()).state).toBe('exited')
  })

  it('lists the processes it has run', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['true'])
    await proc.waitForExit()

    expect((await session.listProcesses()).map(entry => entry.id)).toContain(proc.id)
  })

  it('answers null for a process id it never ran', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    await session.exists('.')

    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
  })

  it('hands argv to the interpreter without a shell reinterpreting it', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    const hostile = 'x\'y $(echo pwned) `echo pwned` *'

    const proc = await session.exec(['echo', hostile])
    await proc.waitForExit()

    expect((await drain(await proc.logs({ replay: true }))).stdout.trim()).toBe(hostile)
  })

  it('passes cwd and env through to the command', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
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

  it('keeps the caller\'s own argv on the handle, not the env wrapper', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['echo', 'hi'], { env: { PROBE: 'x' } })
    const status = await proc.status()
    await proc.waitForExit()

    expect(status.command).toEqual(['echo', 'hi'])
  })

  it('does not let an env value be reinterpreted as shell text', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    const hostile = 'a b\'c $(echo pwned) `echo pwned` ; echo pwned'

    const proc = await session.exec(['sh', '-c', 'printf %s "$PROBE"'], { env: { PROBE: hostile } })
    await proc.waitForExit()

    expect((await drain(await proc.logs({ replay: true }))).stdout).toBe(hostile)
  })

  it('rejects an env name the shell could not export as one word', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    await expect(session.exec(['true'], { env: { 'not a name': 'x' } }))
      .rejects
      .toBeInstanceOf(JustBashEnvNameError)
  })

  it('rejects a wait that expires before the process does', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 3'])
    const wait = proc.waitForExit({ timeout: 200 })

    await expect(wait).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
    await proc.kill()
  })

  it('marks a process killed by its own timeout as timed out', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const exit = await (await session.exec(['sh', '-c', 'sleep 5'], { timeout: 200 })).waitForExit()

    expect(exit.timedOut).toBe(true)
  })

  it('does not mark a command that finished inside its budget as timed out', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    // Read after the budget has elapsed, and without a `waitForExit` to stand the timer down:
    // `timedOut` must still describe the process, not the timer that outlived it.
    const proc = await session.exec(['sh', '-c', 'echo quick'], { timeout: 200 })
    await Bun.sleep(500)
    const status = await proc.status()

    expect(status.state).toBe('exited')
    expect(status.state === 'exited' && status.exit.timedOut).toBe(false)
  })

  it('does not keep the host process alive for a budget nothing is waiting on', async () => {
    // Asserted from outside, because the claim is about the event loop rather than a value: a
    // referenced timer would hold the whole process open. Measured before the fix at the full
    // 30s; an agent turn's budget is hours, and every one of them would be spent idling after
    // the work was done.
    const script = `
      import { createJustBashSandbox } from './src/sandbox/just-bash'
      await createJustBashSandbox().session('t').exec(['sh', '-c', 'echo hi'], { timeout: 30_000 })
    `
    const child = Bun.spawn(['bun', '-e', script], {
      cwd: join(import.meta.dir, '..', '..', '..'),
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const startedAt = Date.now()
    const code = await child.exited

    expect(code).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  }, 30_000)

  it('does not mark a command that returns 124 by itself as timed out', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    // The interpreter reports *every* cancellation as 124, so the exit code cannot carry this
    // distinction — `timedOut` comes from the timer this backend owns.
    const exit = await (await session.exec(['sh', '-c', 'exit 124'], { timeout: 30_000 }))
      .waitForExit()

    expect(exit.code).toBe(124)
    expect(exit.timedOut).toBe(false)
  })

  it('does not mark a caller\'s kill as a timeout', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 5'], { timeout: 30_000 })
    await proc.kill()
    const exit = await proc.waitForExit()

    expect(exit.timedOut).toBe(false)
  })

  it('refuses to invent a port endpoint it cannot back', async () => {
    const { sandboxes, sandboxId } = freshSandbox()

    // Answering `http://127.0.0.1:8080` would resolve to whatever is listening on the *host*.
    // A named error is what tells a harness adapter at once that this backend cannot serve it.
    await expect(sandboxes.portEndpoint(sandboxId, 8080))
      .rejects
      .toBeInstanceOf(JustBashPortsUnavailableError)
  })

  it('has no real binaries, which is the limit that decides when to use it', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['git', '--version'])
    const exit = await proc.waitForExit()

    expect(exit.code).toBe(127)
    expect((await drain(await proc.logs({ replay: true }))).stderr).toContain('command not found')
  })

  it('keeps two sandbox ids on separate filesystems', async () => {
    const { sandboxes } = freshSandbox()
    const one = sandboxes.session('one')
    const two = sandboxes.session('two')

    await one.writeFile('only-in-one.txt', 'x')

    expect((await one.exists('only-in-one.txt')).exists).toBe(true)
    expect((await two.exists('only-in-one.txt')).exists).toBe(false)
  })

  it('destroys the sandbox and its filesystem, idempotently', async () => {
    const { sandboxes, sandboxId } = freshSandbox()
    const session = sandboxes.session(sandboxId)
    await session.writeFile('inside.txt', 'gone soon')

    await session.destroy()

    // A fresh session for the same id gets a fresh interpreter, so the file is gone with it.
    expect((await sandboxes.session(sandboxId).exists('inside.txt')).exists).toBe(false)
    await expect(session.destroy()).resolves.toBeUndefined()
  })
})
