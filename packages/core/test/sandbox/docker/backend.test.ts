import type { ProcessLogEvent, SandboxProvider } from '../../../src/sandbox/contract'
/**
 * The Docker backend against a real daemon.
 *
 * These are integration tests, not unit tests: the backend's whole job is to make one
 * container behave like the contract, and a mocked `docker` CLI would only assert that the
 * arguments match what this code already builds. What is actually in question — whether
 * `setsid` detaches the way the journal assumes, whether `tail --pid` ends when the wrapper
 * does, whether a process survives being read after it exits — is only answerable against
 * the daemon.
 *
 * The whole file skips when no Linux-container daemon is reachable, so a machine without one
 * still runs the rest of the suite.
 */
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '../../../src/sandbox/contract'
import { createDockerSandbox, isDockerAvailable } from '../../../src/sandbox/docker'

const dockerAvailable = await isDockerAvailable()
const WORK_DIR = '/work'
const suite = dockerAvailable ? describe : describe.skip

/** Collect a log stream into per-stream text. */
async function drain(events: ReadableStream<ProcessLogEvent>) {
  const decoder = new TextDecoder()
  const out: string[] = []
  const err: string[] = []
  let terminal: ProcessLogEvent | undefined

  for await (const event of events) {
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

  return { stdout: out.join(''), stderr: err.join(''), terminal }
}

suite('docker sandbox backend', () => {
  const sandboxId = `spec-${crypto.randomUUID().slice(0, 8)}`
  let sandboxes: SandboxProvider

  beforeAll(() => {
    sandboxes = createDockerSandbox({
      image: 'debian:bookworm-slim',
      workDir: WORK_DIR,
      ports: [8080],
    })
  })

  afterAll(async () => {
    if (dockerAvailable) {
      await sandboxes.session(sandboxId).destroy()
    }
  })

  it('reports its backend name', () => {
    expect(sandboxes.backend).toBe('docker')
  })

  it('creates the container lazily, on the first call that needs it', async () => {
    const session = sandboxes.session(sandboxId)

    // Resolving a session touches no daemon; this is the call that creates the container.
    const probe = await session.exists(WORK_DIR)

    expect(probe.exists).toBe(true)
  })

  it('round-trips a text file', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile(`${WORK_DIR}/nested/hello.txt`, 'hello sandbox')
    const read = await session.readFile(`${WORK_DIR}/nested/hello.txt`)

    expect(read.content).toBe('hello sandbox')
  })

  it('creates missing parent directories on write', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile(`${WORK_DIR}/a/b/c/deep.txt`, 'deep')

    expect((await session.exists(`${WORK_DIR}/a/b/c/deep.txt`)).exists).toBe(true)
  })

  it('round-trips bytes that are not valid UTF-8, through base64', async () => {
    const session = sandboxes.session(sandboxId)
    const bytes = Buffer.from([0x00, 0xFF, 0xFE, 0x01]).toString('base64')

    await session.writeFile(`${WORK_DIR}/raw.bin`, bytes, { encoding: 'base64' })
    const read = await session.readFile(`${WORK_DIR}/raw.bin`, { encoding: 'base64' })

    expect(read.content).toBe(bytes)
  })

  it('rejects a read of a path that does not exist', async () => {
    const session = sandboxes.session(sandboxId)

    await expect(session.readFile(`${WORK_DIR}/absent`)).rejects.toThrow()
  })

  it('reports a missing path as absent rather than throwing', async () => {
    const session = sandboxes.session(sandboxId)

    expect((await session.exists(`${WORK_DIR}/absent`)).exists).toBe(false)
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

    // The durability the contract is built on: a handle resolved from the id alone, in code
    // that never started the command, still reads the whole transcript back.
    const recovered = await session.getProcess(proc.id)
    expect(recovered).not.toBeNull()
    const logs = await drain(await recovered!.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('durable')
  })

  it('follows a running process and ends when it does', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo first ; sleep 1 ; echo second'])
    const logs = await drain(await proc.logs({ replay: true, follow: true }))

    expect(logs.stdout).toContain('first')
    expect(logs.stdout).toContain('second')
    expect(logs.terminal?.type).toBe('terminal')
  })

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

    const proc = await session.exec(['sh', '-c', 'sleep 60 & wait'])
    await proc.kill()
    const exit = await proc.waitForExit()

    // The shell reports a signalled child as 128 + signal; SIGTERM is 15.
    expect(exit.code).toBeGreaterThan(128)
  })

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

  it('passes cwd and env through to the process', async () => {
    const session = sandboxes.session(sandboxId)

    await session.mkdir(`${WORK_DIR}/cwd-probe`, { recursive: true })
    const proc = await session.exec(['sh', '-c', 'pwd ; echo "$PROBE"'], {
      cwd: `${WORK_DIR}/cwd-probe`,
      env: { PROBE: 'passed-through' },
    })
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout).toContain(`${WORK_DIR}/cwd-probe`)
    expect(logs.stdout).toContain('passed-through')
  })

  it('quotes argv so a shell cannot reinterpret it', async () => {
    const session = sandboxes.session(sandboxId)
    const hostile = 'x\'y $(echo pwned) `echo pwned` *'

    const proc = await session.exec(['echo', hostile])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe(hostile)
  })

  it('terminates a process that outruns its own timeout', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sleep', '30'], { timeout: 1000 })
    const exit = await proc.waitForExit()

    // 124 is what GNU `timeout` reports for a command it had to terminate, and `timedOut`
    // is the contract's way of saying the process died of its own timeout rather than
    // because a caller stopped waiting.
    expect(exit.code).toBe(124)
    expect(exit.timedOut).toBe(true)
  })

  it('does not mark an ordinary exit as timed out', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['true'])
    const exit = await proc.waitForExit()

    expect(exit.timedOut).toBe(false)
  })

  it('resolves a host address for an exposed port', async () => {
    const endpoint = await sandboxes.portEndpoint(sandboxId, 8080, { protocol: 'ws' })

    expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
  })

  it('reports a vanished process as having journalled no exit', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sleep', '30'])
    // SIGKILL leaves the wrapper no chance to write its exit line, which is exactly the state
    // the contract requires be reported as a rejection rather than a synthetic exit.
    await proc.kill(9)

    await expect(proc.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })
})
