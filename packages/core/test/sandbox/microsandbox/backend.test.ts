/**
 * The microsandbox backend against a real microVM.
 *
 * Integration tests, in the same sense as the Docker suite's: the backend's whole job is to make
 * one microVM behave like the contract, and a mocked napi binding would only assert that the
 * arguments match what this code already builds. What is actually in question — whether the
 * journal wrapper's `setsid` and `tail --pid` behave the same in this guest as in a container,
 * whether a sandbox is adoptable by name from a second host process, whether a process survives
 * being read after it exits — is only answerable against the runtime.
 *
 * **The whole file skips where a microVM cannot be booted**, which includes the host this backend
 * was written on and the CI runner it is tested on, for two different reasons. That is not a
 * workaround — it is the same gate `../docker/backend.test.ts` uses for an unreachable daemon.
 * `./vendor-shape.test.ts` is what still runs everywhere.
 *
 * The gate is a boot, not a load. `isMicrosandboxAvailable()` answers whether the runtime can be
 * imported, and on `darwin-x64` — where the package ships no native addon — that is already the
 * whole answer. It is not the whole answer on Linux: measured on a GitHub-hosted runner, the
 * addon loads and the guest then dies with `SIGABRT` before its agent relay comes up, because a
 * microVM needs a hypervisor the runner does not provide. Gating on the import alone turned that
 * into a red suite on every push. So the gate boots one throwaway sandbox and asks the host
 * directly, which costs one extra boot where the answer is yes and is the only form of the
 * question that does not have to guess at what the runtime needs underneath it.
 *
 * A skip here is genuinely a skip: nothing below has been observed to pass. The type-level claims
 * are checked by `tsc` and by the shape suite; the behavioural ones wait for a host that can boot
 * a microVM.
 */
import type { ProcessLogEvent, SandboxProvider } from '../../../src/sandbox/contract'
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  SandboxFileNotFoundError,
  SandboxWaitTimeoutError,
} from '../../../src/sandbox/contract'
import {
  createMicrosandboxSandbox,
  DEFAULT_IMAGE,
  isMicrosandboxAvailable,
  MicrosandboxPortNotMappedError,
} from '../../../src/sandbox/microsandbox'

const WORK_DIR = '/work'
/** A cold image pull plus a kernel boot outlasts bun's per-test budget by a wide margin. */
const BOOT_TIMEOUT_MS = 300_000

/**
 * Whether this host can boot a microVM, asked by booting one.
 *
 * The import check comes first because it is free and is the whole answer on a platform with no
 * native addon. Past it, nothing short of a boot distinguishes a host that can run a guest from
 * one that only has the library to try.
 *
 * Any failure is a `false` rather than a throw: the question is whether the suite can run, and a
 * host that cannot answer it is a host that cannot run the suite.
 */
async function canBootMicroVm(): Promise<boolean> {
  if (!await isMicrosandboxAvailable()) {
    return false
  }
  const probe = createMicrosandboxSandbox({ image: DEFAULT_IMAGE, workDir: WORK_DIR })
  const session = probe.session(`boot-probe-${crypto.randomUUID().slice(0, 8)}`)
  try {
    await session.exists(WORK_DIR)
    return true
  }
  catch {
    return false
  }
  finally {
    await session.destroy().catch(() => undefined)
  }
}

const available = await canBootMicroVm()
const suite = available ? describe : describe.skip

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

suite('microsandbox backend', () => {
  const sandboxId = `spec-${crypto.randomUUID().slice(0, 8)}`
  let sandboxes: SandboxProvider

  beforeAll(async () => {
    sandboxes = createMicrosandboxSandbox({
      image: DEFAULT_IMAGE,
      workDir: WORK_DIR,
      ports: new Map([[8080, 18080]]),
    })
    // Before the first test, never inside one.
    await sandboxes.session(sandboxId).exists(WORK_DIR)
  }, BOOT_TIMEOUT_MS)

  afterAll(async () => {
    if (available) {
      await sandboxes.session(sandboxId).destroy()
    }
  }, BOOT_TIMEOUT_MS)

  it('reports its backend name', () => {
    expect(sandboxes.backend).toBe('microsandbox')
  })

  it('round-trips a text file', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile(`${WORK_DIR}/nested/hello.txt`, 'hello sandbox')

    expect((await session.readFile(`${WORK_DIR}/nested/hello.txt`)).content).toBe('hello sandbox')
  })

  it('creates missing parent directories on write', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile(`${WORK_DIR}/a/b/c/deep.txt`, 'deep')

    expect((await session.exists(`${WORK_DIR}/a/b/c/deep.txt`)).exists).toBe(true)
  })

  it('round-trips bytes that are not valid UTF-8, through base64', async () => {
    const session = sandboxes.session(sandboxId)
    const bytes = Buffer.from([0x00, 0xFF, 0xFE, 0x01]).toString('base64')

    // Unlike `../just-bash`, this filesystem stores bytes: the write never passes through a
    // shell or a text decode, so the round trip is expected to be exact.
    await session.writeFile(`${WORK_DIR}/raw.bin`, bytes, { encoding: 'base64' })

    expect((await session.readFile(`${WORK_DIR}/raw.bin`, { encoding: 'base64' })).content)
      .toBe(bytes)
  })

  it('streams a read when the caller asks for no encoding', async () => {
    const session = sandboxes.session(sandboxId)

    await session.writeFile(`${WORK_DIR}/streamed.txt`, 'by the chunk')
    const streamed = await session.readFile(`${WORK_DIR}/streamed.txt`, { encoding: 'none' })

    expect(await new Response(streamed.content).text()).toBe('by the chunk')
  })

  it('rejects a read of a path that does not exist', async () => {
    const session = sandboxes.session(sandboxId)

    await expect(session.readFile(`${WORK_DIR}/absent`))
      .rejects
      .toBeInstanceOf(SandboxFileNotFoundError)
  })

  it('reports a directory as existing, not only a file', async () => {
    const session = sandboxes.session(sandboxId)

    await session.mkdir(`${WORK_DIR}/a-directory`, { recursive: true })

    expect((await session.exists(`${WORK_DIR}/a-directory`)).exists).toBe(true)
    expect((await session.exists(`${WORK_DIR}/absent`)).exists).toBe(false)
  })

  it('runs a command and reports its exit code', async () => {
    const session = sandboxes.session(sandboxId)

    const exit = await (await session.exec(['sh', '-c', 'exit 3'])).waitForExit()

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

  it('hands argv to the guest without a shell reinterpreting it', async () => {
    const session = sandboxes.session(sandboxId)
    const hostile = 'x\'y $(echo pwned) `echo pwned` *'

    const proc = await session.exec(['echo', hostile])
    await proc.waitForExit()

    expect((await drain(await proc.logs({ replay: true }))).stdout.trim()).toBe(hostile)
  })

  it('passes cwd and env through to the command', async () => {
    const session = sandboxes.session(sandboxId)
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
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo durable'])
    await proc.waitForExit()
    const recovered = await session.getProcess(proc.id)

    expect(recovered).not.toBeNull()
    expect((await drain(await recovered!.logs({ replay: true }))).stdout.trim()).toBe('durable')
    expect((await recovered!.status()).state).toBe('exited')
  })

  it('resumes from a cursor rather than replaying what the caller already folded in', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo one ; echo two'])
    await proc.waitForExit()
    const first = await drain(await proc.logs({ replay: true }))
    const rest = await drain(await proc.logs({ since: first.terminal?.cursor }))

    expect(first.stdout).toContain('one')
    expect(rest.stdout).toBe('')
  })

  it('follows a log until the process it belongs to ends', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'echo first ; sleep 1 ; echo second'])
    const logs = await drain(await proc.logs({ replay: true, follow: true }))

    // The stream ends on its own — a `tail -f` with no pid to end on would hang here.
    expect(logs.stdout).toContain('first')
    expect(logs.stdout).toContain('second')
    expect(logs.terminal?.type).toBe('terminal')
  })

  it('reports a running process as running, and lists it', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 5'])
    const running = await proc.status()
    await proc.kill()

    expect(running.state).toBe('running')
    expect(running.pid).toBeGreaterThan(0)
    expect((await session.listProcesses()).map(entry => entry.id)).toContain(proc.id)
  })

  it('answers null for a process id it never ran', async () => {
    const session = sandboxes.session(sandboxId)

    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
  })

  it('kills the whole process group, not only the command', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 30 & sleep 30'])
    await proc.kill()
    const probe = await session.exec(['sh', '-c', 'ps -eo args= | grep -c "[s]leep 30" || true'])
    await probe.waitForExit()

    // `setsid` in the journal wrapper is what makes the group the process's own; without it the
    // backgrounded child would outlive the kill.
    expect((await drain(await probe.logs({ replay: true }))).stdout.trim()).toBe('0')
  })

  it('rejects a wait that expires before the process does', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 30'])
    const wait = proc.waitForExit({ timeout: 300 })

    await expect(wait).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
    await proc.kill()
  })

  it('marks a process killed by its own timeout as timed out', async () => {
    const session = sandboxes.session(sandboxId)

    const exit = await (await session.exec(['sh', '-c', 'sleep 30'], { timeout: 500 }))
      .waitForExit()

    expect(exit.timedOut).toBe(true)
  })

  it('does not mark a command that returns 124 by itself as timed out', async () => {
    const session = sandboxes.session(sandboxId)

    // The watchdog's marker file is the fact, never the exit code — 124 is GNU `timeout`'s
    // convention and equally a code a command may return on its own.
    const exit = await (await session.exec(['sh', '-c', 'exit 124'], { timeout: 30_000 }))
      .waitForExit()

    expect(exit.code).toBe(124)
    expect(exit.timedOut).toBe(false)
  })

  it('does not mark a caller\'s kill as a timeout', async () => {
    const session = sandboxes.session(sandboxId)

    const proc = await session.exec(['sh', '-c', 'sleep 30'], { timeout: 60_000 })
    await proc.kill()
    const exit = await proc.waitForExit()

    expect(exit.timedOut).toBe(false)
  })

  it('answers a port endpoint from the mapping the sandbox was built with', async () => {
    const endpoint = await sandboxes.portEndpoint(sandboxId, 8080)

    expect(endpoint.url).toBe('http://127.0.0.1:18080')
  })

  it('refuses a port the sandbox does not publish, rather than inventing one', async () => {
    // Answering `http://127.0.0.1:9999` would dial the host, not the guest.
    await expect(sandboxes.portEndpoint(sandboxId, 9999))
      .rejects
      .toBeInstanceOf(MicrosandboxPortNotMappedError)
  })

  it('adopts the sandbox a second provider names the same, rather than colliding', async () => {
    const second = createMicrosandboxSandbox({
      image: DEFAULT_IMAGE,
      workDir: WORK_DIR,
      ports: new Map([[8080, 18080]]),
    })

    await sandboxes.session(sandboxId).writeFile(`${WORK_DIR}/shared.txt`, 'written by the first')

    // Adoption by name is what makes a journal written by one host process readable by another.
    expect((await second.session(sandboxId).readFile(`${WORK_DIR}/shared.txt`)).content)
      .toBe('written by the first')
  }, BOOT_TIMEOUT_MS)

  it('destroys the sandbox, idempotently', async () => {
    const throwawayId = `${sandboxId}-throwaway`
    const session = sandboxes.session(throwawayId)
    await session.exists(WORK_DIR)

    await session.destroy()

    await expect(sandboxes.session(throwawayId).destroy()).resolves.toBeUndefined()
  }, BOOT_TIMEOUT_MS)
})
