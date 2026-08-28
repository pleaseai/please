/**
 * A `MicroSandbox` backed by a Docker container, so the microsandbox backend can be *run*.
 *
 * `microsandbox` ships no native addon for `darwin-x64` and needs a hypervisor the CI runner does
 * not provide, so `./backend.test.ts` skips on both — which left every line between
 * `createMicrosandboxSession` and the guest unexecuted anywhere. This closes that gap without
 * pretending the vendor is present: the backend is written against the structural copies in
 * `../../../src/sandbox/microsandbox/runtime.ts`, and a copy that only ever has one implementation
 * is a copy nothing has checked is implementable.
 *
 * **This is a stand-in for the runtime, not a mock of the backend.** Nothing here knows what the
 * code under test intends to run. `execWith` hands argv to a real `execve` in a real container,
 * `fs()` reads and writes real files, and a `sleep 30` really keeps running after the call that
 * started it returns. So the assertions are about behaviour — a journal survives the process that
 * wrote it, a group kill reaches a grandchild, a cursor resumes where it left off — and not about
 * whether an argv matches the one the code just built.
 *
 * A container is the right stand-in because the guest requirements are the same ones
 * `../../../src/sandbox/microsandbox/session.ts` states for a microVM: a POSIX `sh`, `setsid`,
 * `tail`, `kill` and a readable `/proc`. What it cannot stand in for is the boundary itself —
 * hypervisor isolation, and the vendor's own napi transport. `./vendor-shape.test.ts` is what
 * keeps the copies honest about the second; the first is not something a test asserts.
 */
import type { DockerResult } from '../../../src/sandbox/docker/cli'
import type {
  MicroExecEvent,
  MicroExecHandle,
  MicroExecOptionsBuilder,
  MicroExecOutput,
  MicroFsMetadata,
  MicroFsOps,
  MicroFsReadStream,
  MicroSandbox,
} from '../../../src/sandbox/microsandbox/runtime'
import type { MicroVmHandle } from '../../../src/sandbox/microsandbox/sandbox'
import { runDocker } from '../../../src/sandbox/docker/cli'
import { execInContainer, execInContainerBytes, spawnInContainer } from '../../../src/sandbox/docker/exec'

/** What the vendor reports for an exec it stopped at its own deadline. */
const TIMEOUT_EXIT_CODE = 124

const decoder = new TextDecoder()

/**
 * The four setters this backend uses, recorded rather than applied.
 *
 * A class, because {@link MicroExecOptionsBuilder} is written with `this` return types — the copy
 * has to be satisfiable by the vendor's own fluent builder, and a plain object literal cannot
 * express that.
 */
class FakeExecOptions implements MicroExecOptionsBuilder {
  argv: string[] = []
  workDir: string | undefined
  environment: Record<string, string> | undefined
  budgetMs: number | undefined

  args(args: string[]): this {
    this.argv = [...args]
    return this
  }

  cwd(cwd: string): this {
    this.workDir = cwd
    return this
  }

  envs(vars: Record<string, string>): this {
    this.environment = { ...vars }
    return this
  }

  timeout(ms: number): this {
    this.budgetMs = ms
    return this
  }
}

function toOutput(result: { exitCode: number, stdout: Uint8Array, stderr: string }): MicroExecOutput {
  return {
    code: result.exitCode,
    success: result.exitCode === 0,
    stdout: () => decoder.decode(result.stdout),
    stderr: () => result.stderr,
    stdoutBytes: () => result.stdout,
  }
}

function assertOk(result: DockerResult, what: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`fake runtime: ${what} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}

/**
 * Run one exec, honouring the options the builder recorded.
 *
 * The timeout is enforced here rather than in the guest, because that is where the vendor
 * enforces it: it reports a stopped exec as a non-zero exit rather than by rejecting, so the
 * backend never sees a distinct timeout error and neither does this.
 */
async function runExec(
  container: string,
  cmd: string,
  options: FakeExecOptions,
): Promise<MicroExecOutput> {
  const argv = [cmd, ...options.argv]
  const base = {
    ...(options.workDir === undefined ? {} : { cwd: options.workDir }),
    ...(options.environment === undefined ? {} : { env: options.environment }),
  }
  if (options.budgetMs === undefined) {
    return toOutput(await execInContainerBytes(container, argv, base))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.budgetMs)
  try {
    return toOutput(await execInContainerBytes(container, argv, {
      ...base,
      abortSignal: controller.signal,
    }))
  }
  catch {
    return toOutput({ exitCode: TIMEOUT_EXIT_CODE, stdout: new Uint8Array(), stderr: '' })
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * The vendor's streamed exec, as events over a container's stdout.
 *
 * Only `stdout` and `exited` are produced. That is not a simplification of the vendor — it is
 * what `spawnArgv` consumes, and every caller of it in this backend is reading one file through
 * `cat` or `tail`, where a merged `stderr` would corrupt the bytes being read.
 */
function toHandle(child: ReturnType<typeof spawnInContainer>): MicroExecHandle {
  const reader = child.stdout.getReader()
  let finished = false

  const recv = async (): Promise<MicroExecEvent | null> => {
    if (finished) {
      return null
    }
    const chunk = await reader.read()
    if (chunk.done) {
      finished = true
      return { kind: 'exited', code: await child.exited }
    }
    return { kind: 'stdout', data: chunk.value }
  }

  return {
    recv,
    wait: async () => ({ code: await child.exited }),
    collect: async () => {
      const chunks: Uint8Array[] = []
      for (;;) {
        const event = await recv()
        if (event === null || event.kind === 'exited') {
          break
        }
        if (event.kind === 'stdout') {
          chunks.push(event.data)
        }
      }
      return toOutput({
        exitCode: await child.exited,
        stdout: new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()),
        stderr: '',
      })
    },
    kill: async () => {
      finished = true
      child.kill()
      await child.exited
    },
  }
}

/**
 * The guest filesystem, over `docker exec` rather than a napi channel.
 *
 * Every failure mode the backend depends on is reproduced, because each one is a branch it takes:
 * a read of a missing file throws (`files.ts` turns that into the contract's error only once
 * `exists` agrees), and a write into a missing directory throws (`files.ts` retries it behind a
 * `mkdir -p`, rather than paying for one on every write).
 */
function fakeFs(container: string): MicroFsOps {
  const read = async (path: string): Promise<Uint8Array> => {
    const result = await execInContainerBytes(container, ['cat', '--', path])
    if (result.exitCode !== 0) {
      throw new Error(`fake runtime: reading '${path}' failed: ${result.stderr.trim()}`)
    }
    return result.stdout
  }

  return {
    read,
    readStream: async (path: string): Promise<MicroFsReadStream> => {
      // Read eagerly, so a missing file rejects here rather than through an empty stream — the
      // vendor settles existence before handing a stream back, and `files.ts` relies on it.
      const bytes = await read(path)
      let sent = false
      return {
        recv: async () => {
          if (sent) {
            return null
          }
          sent = true
          return bytes
        },
        collect: async () => bytes,
      }
    },
    write: async (path: string, data: Uint8Array | string): Promise<void> => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      const result = await execInContainer(container, ['sh', '-c', 'cat > "$1"', 'sh', path], {
        stdin: bytes,
      })
      assertOk(result, `writing '${path}'`)
    },
    mkdir: async (path: string): Promise<void> => {
      assertOk(await execInContainer(container, ['mkdir', '--', path]), `creating '${path}'`)
    },
    stat: async (path: string): Promise<MicroFsMetadata> => {
      const result = await execInContainer(container, ['stat', '-c', '%s', '--', path])
      assertOk(result, `stat of '${path}'`)
      return { size: Number.parseInt(result.stdout.trim(), 10) }
    },
    exists: async (path: string): Promise<boolean> => (
      (await execInContainer(container, ['test', '-e', path])).exitCode === 0
    ),
  }
}

function fakeSandbox(container: string): MicroSandbox {
  // The callback is typed to the copy, not to this class, and its return value is discarded: a
  // fluent builder mutates itself and returns `this`, so the instance handed in is the record.
  // Reading the return instead would require `MicroSandbox<FakeExecOptions>`, which is not
  // assignable to the plain `MicroSandbox` a handle promises — a callback parameter is checked
  // contravariantly, the same rule `./vendor-shape.test.ts` documents for the vendor's builder.
  const withOptions = (
    configure: (builder: MicroExecOptionsBuilder) => MicroExecOptionsBuilder,
  ): FakeExecOptions => {
    const builder = new FakeExecOptions()
    configure(builder)
    return builder
  }
  const fromArgs = (args?: Iterable<string>): FakeExecOptions =>
    new FakeExecOptions().args([...(args ?? [])])

  return {
    name: container,
    exec: (cmd, args) => runExec(container, cmd, fromArgs(args)),
    execWith: (cmd, configure) => runExec(container, cmd, withOptions(configure)),
    execStream: async (cmd, args) => {
      const options = fromArgs(args)
      return toHandle(spawnInContainer(container, [cmd, ...options.argv]))
    },
    execStreamWith: async (cmd, configure) => {
      const options = withOptions(configure)
      return toHandle(spawnInContainer(container, [cmd, ...options.argv], {
        ...(options.workDir === undefined ? {} : { cwd: options.workDir }),
        ...(options.environment === undefined ? {} : { env: options.environment }),
      }))
    },
    fs: () => fakeFs(container),
    kill: async () => {
      await runDocker(['rm', '--force', container])
    },
  }
}

export interface FakeMicroVm {
  /** What `createMicrosandboxSession({ handle })` takes. */
  readonly handle: MicroVmHandle
  /** The container standing in for the guest, for a test that needs to look inside it. */
  readonly container: string
  readonly stop: () => Promise<void>
}

/**
 * Start one container and present it as a {@link MicroVmHandle}.
 *
 * `ready()` and `peek()` answer the same sandbox because the container is created up front: the
 * laziness they exist for belongs to `../../../src/sandbox/microsandbox/sandbox.ts`, which
 * `./provider.test.ts` covers without a runtime. What a session needs from a handle is a sandbox
 * to talk to.
 */
export async function startFakeMicroVm(options: {
  image: string
  workDir: string
}): Promise<FakeMicroVm> {
  const container = `please-fake-ms-${crypto.randomUUID().slice(0, 12)}`
  const created = await runDocker([
    'run',
    '--detach',
    '--name',
    container,
    '--workdir',
    options.workDir,
    '--entrypoint',
    'sh',
    options.image,
    '-c',
    'while : ; do sleep 3600 ; done',
  ])
  assertOk(created, `starting '${container}'`)

  const sandbox = fakeSandbox(container)
  let removed = false
  const stop = async (): Promise<void> => {
    if (removed) {
      return
    }
    removed = true
    await runDocker(['rm', '--force', container])
  }

  return {
    container,
    stop,
    handle: {
      name: container,
      ready: async () => sandbox,
      peek: async () => (removed ? undefined : sandbox),
      remove: stop,
    },
  }
}
