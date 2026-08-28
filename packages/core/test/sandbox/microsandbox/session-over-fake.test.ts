/**
 * The microsandbox backend, driven through a stand-in runtime.
 *
 * `./backend.test.ts` is the same backend against a real microVM and skips wherever one cannot be
 * booted — which is every host available to this project. That left `session.ts`, `process.ts`,
 * `process-state.ts`, `process-logs.ts`, `guest.ts` and `files.ts` type-checked and never once
 * executed. This suite runs all six by handing `createMicrosandboxSession` a `MicroVmHandle` whose
 * sandbox is a container rather than a microVM; see `./fake-runtime.ts` for why a container is a
 * fair stand-in and what it deliberately does not stand in for.
 *
 * The assertions are the ones `./backend.test.ts` makes, because they are the right ones and
 * because keeping them identical is what makes this suite evidence about that one: a change that
 * breaks the backend has to break it here too. What is left out is what the fake cannot speak to —
 * port mapping, adoption by name, and the microVM's own lifecycle — all of which `./provider.test.ts`
 * covers without a runtime.
 */
import type { ProcessLogEvent } from '../../../src/sandbox/contract'
import type { FakeMicroVm } from './fake-runtime'
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  SandboxFileNotFoundError,
  SandboxNoExitRecordError,
  SandboxWaitTimeoutError,
} from '../../../src/sandbox/contract'
import { isDockerAvailable } from '../../../src/sandbox/docker'
import { createMicrosandboxSession } from '../../../src/sandbox/microsandbox'
import { IMAGE_PULL_TIMEOUT_MS, pullSandboxImage, SANDBOX_IMAGE } from '../docker/image.fixtures'
import { startFakeMicroVm } from './fake-runtime'

const suite = await isDockerAvailable() ? describe : describe.skip

const WORK_DIR = '/work'

/** Collect a log stream into per-stream text, keeping the terminal event it ended on. */
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

suite('microsandbox session over a stand-in runtime', () => {
  let vm: FakeMicroVm
  let session: ReturnType<typeof createMicrosandboxSession>

  beforeAll(async () => {
    await pullSandboxImage()
    vm = await startFakeMicroVm({ image: SANDBOX_IMAGE, workDir: WORK_DIR })
    session = createMicrosandboxSession({ handle: vm.handle })
  }, IMAGE_PULL_TIMEOUT_MS)

  afterAll(async () => {
    await vm?.stop()
  })

  it('round-trips a text file', async () => {
    await session.writeFile(`${WORK_DIR}/nested/hello.txt`, 'hello sandbox')

    expect((await session.readFile(`${WORK_DIR}/nested/hello.txt`)).content).toBe('hello sandbox')
  })

  it('creates missing parent directories on write', async () => {
    await session.writeFile(`${WORK_DIR}/a/b/c/deep.txt`, 'deep')

    expect((await session.exists(`${WORK_DIR}/a/b/c/deep.txt`)).exists).toBe(true)
  })

  it('round-trips bytes that are not valid UTF-8, through base64', async () => {
    const bytes = Buffer.from([0x00, 0xFF, 0xFE, 0x01]).toString('base64')

    // This filesystem stores bytes: the write never passes through a shell or a text decode.
    await session.writeFile(`${WORK_DIR}/raw.bin`, bytes, { encoding: 'base64' })

    expect((await session.readFile(`${WORK_DIR}/raw.bin`, { encoding: 'base64' })).content)
      .toBe(bytes)
  })

  it('streams a read when the caller asks for no encoding', async () => {
    await session.writeFile(`${WORK_DIR}/streamed.txt`, 'by the chunk')
    const streamed = await session.readFile(`${WORK_DIR}/streamed.txt`, { encoding: 'none' })

    expect(await new Response(streamed.content).text()).toBe('by the chunk')
  })

  it('writes a byte stream straight through', async () => {
    const source = new Response('from a stream').body!

    await session.writeFile(`${WORK_DIR}/streamed-in.txt`, source)

    expect((await session.readFile(`${WORK_DIR}/streamed-in.txt`)).content).toBe('from a stream')
  })

  it('rejects a read of a path that does not exist', async () => {
    await expect(session.readFile(`${WORK_DIR}/absent`))
      .rejects
      .toBeInstanceOf(SandboxFileNotFoundError)
  })

  it('rejects a streamed read of a path that does not exist, rather than streaming nothing', async () => {
    // An empty stream reads as an empty file, which is a different answer from "no such file".
    await expect(session.readFile(`${WORK_DIR}/absent`, { encoding: 'none' }))
      .rejects
      .toBeInstanceOf(SandboxFileNotFoundError)
  })

  it('reports a directory as existing, not only a file', async () => {
    await session.mkdir(`${WORK_DIR}/a-directory`, { recursive: true })

    expect((await session.exists(`${WORK_DIR}/a-directory`)).exists).toBe(true)
    expect((await session.exists(`${WORK_DIR}/absent`)).exists).toBe(false)
  })

  it('runs a command and reports its exit code', async () => {
    const exit = await (await session.exec(['sh', '-c', 'exit 3'])).waitForExit()

    expect(exit.code).toBe(3)
    expect(exit.timedOut).toBe(false)
  })

  it('keeps stdout and stderr apart', async () => {
    const proc = await session.exec(['sh', '-c', 'echo to-out ; echo to-err >&2'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('to-out')
    expect(logs.stderr.trim()).toBe('to-err')
  })

  it('hands argv to the guest without a shell reinterpreting it', async () => {
    const hostile = 'x\'y $(echo pwned) `echo pwned` *'

    const proc = await session.exec(['echo', hostile])
    await proc.waitForExit()

    expect((await drain(await proc.logs({ replay: true }))).stdout.trim()).toBe(hostile)
  })

  it('passes cwd and env through to the command', async () => {
    await session.mkdir(`${WORK_DIR}/cwd-probe`, { recursive: true })

    const proc = await session.exec(['sh', '-c', 'pwd ; echo "$PROBE"'], {
      cwd: `${WORK_DIR}/cwd-probe`,
      env: { PROBE: 'passed-through' },
    })
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout).toContain('cwd-probe')
    expect(logs.stdout).toContain('passed-through')
  })

  it('reads a process back after it exited, in a handle it never started', async () => {
    const proc = await session.exec(['sh', '-c', 'echo durable'])
    await proc.waitForExit()
    const recovered = await session.getProcess(proc.id)

    expect(recovered).not.toBeNull()
    expect((await drain(await recovered!.logs({ replay: true }))).stdout.trim()).toBe('durable')
    expect((await recovered!.status()).state).toBe('exited')
  })

  it('resumes from a cursor rather than replaying what the caller already folded in', async () => {
    const proc = await session.exec(['sh', '-c', 'echo one ; echo two'])
    await proc.waitForExit()
    const first = await drain(await proc.logs({ replay: true }))
    const rest = await drain(await proc.logs({ since: first.terminal?.cursor }))

    expect(first.stdout).toContain('one')
    expect(rest.stdout).toBe('')
  })

  it('starts at the live tail when replay is not asked for', async () => {
    const proc = await session.exec(['sh', '-c', 'echo written-before ; sleep 0.4'])
    await proc.waitForExit()
    // Offsets come from `fs().stat`, gated on `fs().exists`; a failed measurement must not read
    // as zero, which would replay the whole log as though it had just arrived.
    const tail = await drain(await proc.logs({}))

    expect(tail.stdout).not.toContain('written-before')
  })

  it('follows a log until the process it belongs to ends', async () => {
    const proc = await session.exec(['sh', '-c', 'echo first ; sleep 1 ; echo second'])
    const logs = await drain(await proc.logs({ replay: true, follow: true }))

    // The stream ends on its own — a `tail -f` with no pid to end on would hang here.
    expect(logs.stdout).toContain('first')
    expect(logs.stdout).toContain('second')
    expect(logs.terminal?.type).toBe('terminal')
  }, 20_000)

  it('reports a running process as running, and lists it', async () => {
    const proc = await session.exec(['sh', '-c', 'sleep 5'])
    const running = await proc.status()
    await proc.kill()

    expect(running.state).toBe('running')
    expect(running.pid).toBeGreaterThan(0)
    expect((await session.listProcesses()).map(entry => entry.id)).toContain(proc.id)
  })

  it('answers null for a process id it never ran', async () => {
    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
  })

  it('kills the whole process group, not only the command', async () => {
    const proc = await session.exec(['sh', '-c', 'sleep 41.5 & sleep 41.5'])
    await proc.kill()

    // Counted through `/proc` rather than `ps`, which this image does not ship, and matched on
    // the whole cmdline so the probe's own `sh -c` — which contains the same text — is not one.
    const probe = await session.exec(['sh', '-c', [
      'n=0',
      'for p in /proc/[0-9]* ; do',
      '  c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)',
      '  if [ "$c" = "sleep 41.5 " ] ; then n=$((n+1)) ; fi',
      'done',
      'echo "$n"',
    ].join('\n')])
    await probe.waitForExit()

    // `setsid` in the journal wrapper is what makes the group the process's own; without it the
    // backgrounded child would outlive the kill.
    expect((await drain(await probe.logs({ replay: true }))).stdout.trim()).toBe('0')
  }, 20_000)

  it('rejects a wait that expires before the process does', async () => {
    const proc = await session.exec(['sh', '-c', 'sleep 30'])
    const wait = proc.waitForExit({ timeout: 300 })

    await expect(wait).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
    await proc.kill()
  })

  it('rejects a wait the caller aborts, rather than inventing an exit', async () => {
    const proc = await session.exec(['sh', '-c', 'sleep 30'])
    const controller = new AbortController()
    const wait = proc.waitForExit({ signal: controller.signal })
    controller.abort()

    await expect(wait).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
    await proc.kill()
  })

  it('reports a process that vanished without journalling an exit', async () => {
    const proc = await session.exec(['sleep', '30'])
    // SIGKILL leaves the wrapper no chance to write its exit line, which is exactly the state
    // the contract requires be reported as a rejection rather than a synthetic exit.
    await proc.kill(9)

    await expect(proc.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
    expect((await proc.status()).state).toBe('error')
    // A log stream closes on the same fact rather than hanging or reporting a synthetic exit.
    const logs = await drain(await proc.logs({ replay: true }))
    expect(logs.terminal?.type === 'terminal' ? logs.terminal.state : undefined).toBe('error')
  }, 20_000)

  it('marks a process killed by its own timeout as timed out', async () => {
    const exit = await (await session.exec(['sh', '-c', 'sleep 30'], { timeout: 500 }))
      .waitForExit()

    expect(exit.timedOut).toBe(true)
  }, 20_000)

  it('does not mark a command that returns 124 by itself as timed out', async () => {
    // The watchdog's marker file is the fact, never the exit code — 124 is GNU `timeout`'s
    // convention and equally a code a command may return on its own.
    const exit = await (await session.exec(['sh', '-c', 'exit 124'], { timeout: 30_000 }))
      .waitForExit()

    expect(exit.code).toBe(124)
    expect(exit.timedOut).toBe(false)
  })

  it('does not mark a caller\'s kill as a timeout', async () => {
    const proc = await session.exec(['sh', '-c', 'sleep 30'], { timeout: 60_000 })
    await proc.kill()
    const exit = await proc.waitForExit()

    expect(exit.timedOut).toBe(false)
  })

  it('destroys the sandbox, and answers nothing about it afterwards', async () => {
    const throwaway = await startFakeMicroVm({ image: SANDBOX_IMAGE, workDir: WORK_DIR })
    const doomed = createMicrosandboxSession({ handle: throwaway.handle })
    const proc = await doomed.exec(['sh', '-c', 'echo gone'])
    await proc.waitForExit()

    await doomed.destroy()

    // Discovery must not stand a sandbox back up as a side effect of the question.
    expect(await doomed.getProcess(proc.id)).toBeNull()
    expect(await doomed.listProcesses()).toEqual([])
    await expect(doomed.destroy()).resolves.toBeUndefined()
  }, IMAGE_PULL_TIMEOUT_MS)
})
