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
import { IMAGE_PULL_TIMEOUT_MS, pullSandboxImage, SANDBOX_IMAGE } from './image.fixtures'

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

  beforeAll(async () => {
    // Before the first test, never inside one: a cold pull outlasts bun's per-test budget.
    await pullSandboxImage()
    sandboxes = createDockerSandbox({
      image: SANDBOX_IMAGE,
      workDir: WORK_DIR,
      ports: [8080],
    })
  }, IMAGE_PULL_TIMEOUT_MS)

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
    const pidFile = `${WORK_DIR}/grandchild.pid`

    // The grandchild publishes its own pid, because the wrapper's exit code only ever
    // describes the wrapper's direct child — a group kill that missed the `sleep` would
    // leave it running behind an exit code that looked perfectly correct.
    const proc = await session.exec(['sh', '-c', `sleep 60 & echo $! > ${pidFile} ; wait`])
    const deadline = Date.now() + 10_000
    while (!(await session.exists(pidFile)).exists) {
      // Bounded, because an unbounded wait for a file that never appears hangs the whole
      // suite instead of failing this one test.
      expect(Date.now(), `grandchild never published its pid to ${pidFile}`).toBeLessThan(deadline)
      await Bun.sleep(50)
    }
    const grandchild = (await session.readFile(pidFile)).content.trim()

    await proc.kill()
    const exit = await proc.waitForExit()

    // `kill -0` cannot answer this: the grandchild is reparented to the container's PID 1
    // — `sleep infinity`, which reaps nothing — so a terminated one lingers as a zombie that
    // still accepts signals. Its scheduler state is what actually distinguishes the two.
    // The fallback is gated on the state being empty, not on the pipeline failing: when the
    // stat file is gone `sed` fails but `cut` still exits 0 on empty stdin, so `|| echo gone`
    // would never run and the probe would print nothing.
    const probe = await session.exec(['sh', '-c', [
      `state=$(sed 's/.*) //' /proc/${grandchild}/stat 2>/dev/null | cut -d' ' -f1)`,
      '[ -n "$state" ] || state=gone',
      'echo "$state"',
    ].join('\n')])
    await probe.waitForExit()
    const probeLogs = await drain(await probe.logs({ replay: true }))

    // `Z` is a terminated grandchild awaiting a reaper that never comes; `gone` is one
    // already reaped. A `sleep 60` that outlived the group kill would report `S`.
    expect(['Z', 'gone']).toContain(probeLogs.stdout.trim())
    // The shell reports a signalled child as 128 + signal; SIGTERM is 15.
    expect(exit.code).toBe(143)
    expect(exit.signal).toBe(15)
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

  it('answers cold rather than creating a container when a sandbox was never started', async () => {
    const session = sandboxes.session(`cold-${crypto.randomUUID().slice(0, 8)}`)

    expect(await session.getProcess(crypto.randomUUID())).toBeNull()
    expect(await session.listProcesses()).toEqual([])
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

  it('declares IS_SANDBOX to every process it runs', async () => {
    const session = sandboxes.session(sandboxId)

    // The Claude Code CLI refuses its bypass permission mode as root unless this is set, and
    // the sandbox image runs as root, so the backend claims it at container creation.
    const proc = await session.exec(['sh', '-c', 'echo "$IS_SANDBOX"'])
    await proc.waitForExit()
    const logs = await drain(await proc.logs({ replay: true }))

    expect(logs.stdout.trim()).toBe('1')
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

    // The watchdog terminates the group, so the exit is an ordinary signalled one — and
    // `timedOut` comes from the marker it writes before firing, not from the exit code.
    // `timedOut` is the contract's way of saying the process died of its own timeout rather
    // than because a caller stopped waiting.
    expect(exit.timedOut).toBe(true)
    expect(exit.code).toBe(143)
    expect(exit.signal).toBe(15)
  })

  it('acts on a sub-second timeout, whose fractional literal the container shell accepts', async () => {
    const session = sandboxes.session(sandboxId)

    const startedAt = Date.now()
    const proc = await session.exec(['sleep', '30'], { timeout: 200 })
    const exit = await proc.waitForExit({ timeout: 20_000 })

    expect(exit.timedOut).toBe(true)
    expect(exit.code).toBe(143)
    expect(exit.signal).toBe(15)
    // What this bound excludes is a watchdog that never fired: `sleep 0.200` being rejected by
    // the container's shell, or rounded down to nothing, leaves `sleep 30` to run its full
    // course. It deliberately does NOT claim to separate 200ms from 1000ms — the first
    // timeout-terminated process in a container costs ~1.9s more than later ones, measured, and
    // that one-off swamps the ~790ms difference it would have to resolve. An earlier version of
    // this test asserted `< 1000ms` and failed on CI at 2263ms with the wrapper emitting a
    // perfectly correct `sleep 0.200`; a differential version failed the same way at -1139ms.
    // The exact seconds literal is asserted with no clock and no container in `journal.test.ts`,
    // which is where that claim can actually be made deterministically.
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  }, 40_000)

  it('forces down a command that ignores SIGTERM once its timeout grace expires', async () => {
    const session = sandboxes.session(sandboxId)

    // The only test that reaches the escalation. Every other timeout test uses a command that
    // dies of the watchdog's `SIGTERM`, and so stops one step short: the branch that spawns
    // `escalate`, waits out `KILL_GRACE_SECONDS`, and walks `/proc` to `kill -9` the group's
    // remaining members never runs. GNU `timeout -k` used to supply that step; since the
    // watchdog replaced it, a regression here means a command that ignores `SIGTERM` outlives
    // its timeout and the wrapper's wait loop never ends — every `waitForExit` on that
    // container then fails with a wait timeout instead.
    const proc = await session.exec(
      ['sh', '-c', 'trap \'\' TERM ; while : ; do sleep 1 ; done'],
      { timeout: 300 },
    )
    const exit = await proc.waitForExit({ timeout: 30_000 })

    // 137 is `128 + 9`, and the `signal` record is what proves the 9 rather than a command
    // that merely returned 137 — the two are indistinguishable from the exit code alone.
    // Reaching either at all requires the escalation: a trapped `SIGTERM` cannot produce them.
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

    // 124 is GNU `timeout`'s code for a command it terminated, and equally a code a command
    // may return on its own. Inferring the timeout from it confuses the two.
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
