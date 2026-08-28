/**
 * One microVM, as the contract's {@link SandboxSession}.
 *
 * **The journal is `../docker/journal.ts`, imported rather than copied.** That module contains no
 * Docker: it builds a POSIX shell script — `setsid`, traps, a watchdog, an exit record — that
 * answers a question every guest-side backend has, which is how a process outlives the call that
 * started it. Duplicating two hundred lines of signal-handling shell into a second backend would
 * give the project two copies to keep correct, and the second copy would drift. A shared home for
 * it is the obvious refactor once a *third* backend needs it; two do not yet justify moving a
 * file that the Docker suite covers where it stands.
 *
 * What that shell needs from the guest is therefore this backend's obligation too: a POSIX `sh`,
 * `setsid`, `tail`, `kill` and a readable `/proc`. `./provider.ts` names it on the image option.
 */
import type {
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '../contract'
import type { JournalMeta } from '../docker/journal'
import type { MicroSandbox } from './runtime'
import type { MicroVmHandle } from './sandbox'
import { JOURNAL_ROOT, journalledCommand, journalPaths } from '../docker/journal'
import { quoteArg } from '../docker/shell-quote'
import { createMicrosandboxFiles } from './files'
import { execArgv, execScript } from './guest'
import { createProcessHandle } from './process'
import { readFullJournalState, readJournalState, toProcessStatus } from './process-state'

/** How long `exec` waits for the wrapper to record that it started. */
const START_TIMEOUT_MS = 5_000
const START_POLL_MS = 50

/**
 * Wait until the wrapper has journalled a pid — or already an exit, for a command short enough to
 * finish first.
 *
 * The launching exec returns as soon as the runtime has accepted it, which says nothing about
 * whether the wrapper ran. Returning a handle before either file exists would hand the caller one
 * whose first `status()` reports `error`, for a process that is starting normally.
 */
async function waitForStart(
  sandbox: MicroSandbox,
  paths: ReturnType<typeof journalPaths>,
  processId: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    const state = await readJournalState(sandbox, paths)
    if (state.pid !== undefined || state.exit !== undefined) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`process '${processId}' did not start inside the sandbox`)
    }
    await Bun.sleep(START_POLL_MS)
  }
}

/** Best-effort teardown of a process whose start could not be confirmed. */
async function abandonStartedProcess(
  sandbox: MicroSandbox,
  paths: ReturnType<typeof journalPaths>,
): Promise<void> {
  // The marker goes down first, and the journal directory is deliberately left in place to carry
  // it. In the window this exists for, the wrapper has not written a pid yet — there is nothing
  // to kill, and the marker is the only thing that can stop it launching at all. Deleting the
  // directory here would delete the one instruction it is waiting to read.
  const script = [
    `mkdir -p ${quoteArg(paths.dir)}`,
    `: > ${quoteArg(paths.abandon)}`,
    `pid=$(cat ${quoteArg(paths.pid)} 2>/dev/null)`,
    'if [ -n "$pid" ] ; then kill -9 "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null ; fi',
  ].join('\n')
  await execScript(sandbox, script).catch(() => undefined)
}

/**
 * Start one command.
 *
 * The wrapper is launched **without a per-exec timeout**, even when the caller asked for one. The
 * budget belongs to the journalled process, and the vendor's `timeout` would apply to the
 * launching exec instead — cancelling the wrapper mid-flight and leaving the real command running
 * with nothing left to journal it. The watchdog inside the wrapper is what enforces the deadline,
 * which is also what makes `timedOut` a recorded fact rather than a guess at an exit code.
 */
async function exec(
  handle: MicroVmHandle,
  command: SandboxCommand,
  options: SandboxExecOptions = {},
): Promise<SandboxProcessHandle> {
  const sandbox = await handle.ready()
  const processId = crypto.randomUUID()
  const paths = journalPaths(processId)
  const meta: JournalMeta = {
    id: processId,
    command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    startedAt: new Date().toISOString(),
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  }

  const script = journalledCommand({
    paths,
    command,
    meta,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  })
  const started = await execScript(sandbox, script, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  if (started.exitCode !== 0) {
    throw new Error(`starting a process failed (exit ${started.exitCode}): ${started.stderr.trim()}`)
  }

  try {
    await waitForStart(sandbox, paths, processId)
  }
  catch (cause) {
    // The wrapper may be running even though its journal never became readable in time.
    // Rejecting without this would return no handle for a live process — nothing could ever kill
    // it, and nothing could ever read it.
    await abandonStartedProcess(sandbox, paths)
    throw cause
  }
  return createProcessHandle({ sandbox, processId, paths, command })
}

async function getProcess(
  handle: MicroVmHandle,
  processId: string,
): Promise<SandboxProcessHandle | null> {
  // Discovery must not create: asking whether a sandbox ever ran a process is a question, and a
  // question that boots a microVM has changed the thing it was asking about.
  const sandbox = await handle.peek()
  if (sandbox === undefined) {
    return null
  }
  const paths = journalPaths(processId)
  const probe = await execScript(
    sandbox,
    `[ -d ${quoteArg(paths.dir)} ] && [ ! -e ${quoteArg(paths.abandon)} ]`,
  )
  if (probe.exitCode !== 0) {
    return null
  }

  const state = await readFullJournalState(sandbox, paths)
  return createProcessHandle({
    sandbox,
    processId,
    paths,
    command: state.meta?.command ?? (['unknown'] as unknown as SandboxCommand),
  })
}

async function listProcesses(handle: MicroVmHandle): Promise<ProcessStatus[]> {
  const sandbox = await handle.peek()
  if (sandbox === undefined) {
    return []
  }
  // Abandoned journals are skipped rather than deleted. The marker is what a wrapper still
  // starting up reads to know not to launch, so removing it would reintroduce the race it exists
  // to close — but a command that never ran is not a process, and reporting it as one would give
  // every later `listProcesses()` a permanent phantom in the `error` state.
  const listing = await execScript(sandbox, [
    `for dir in ${JOURNAL_ROOT}/*/ ; do`,
    '  [ -d "$dir" ] || continue',
    '  [ -e "$dir/abandon" ] && continue',
    '  basename "$dir"',
    'done 2>/dev/null || true',
  ].join('\n'))
  const ids = listing.stdout.split('\n').map(id => id.trim()).filter(id => id.length > 0)

  return Promise.all(ids.map(async (id) => {
    const state = await readFullJournalState(sandbox, journalPaths(id))
    return toProcessStatus(id, state, state.meta?.command ?? (['unknown'] as unknown as SandboxCommand))
  }))
}

export interface MicrosandboxSessionOptions {
  handle: MicroVmHandle
}

export function createMicrosandboxSession(options: MicrosandboxSessionOptions): SandboxSession {
  const { handle } = options

  // The file surface needs a sandbox, which is only known once acquired. Each call resolves it,
  // so nothing is created until one is made.
  const files = {
    readFile: async (path: string, fileOptions?: { encoding?: never }) =>
      createMicrosandboxFiles(await handle.ready()).readFile(path, fileOptions),
    writeFile: async (
      path: string,
      content: string | ReadableStream<Uint8Array>,
      fileOptions?: { encoding?: never },
    ) => createMicrosandboxFiles(await handle.ready()).writeFile(path, content, fileOptions),
    mkdir: async (path: string, fileOptions?: { recursive?: boolean }) =>
      createMicrosandboxFiles(await handle.ready()).mkdir(path, fileOptions),
  } as unknown as Pick<SandboxSession, 'readFile' | 'writeFile' | 'mkdir'>

  return {
    ...files,
    exec: (command, execOptions) => exec(handle, command, execOptions),
    getProcess: processId => getProcess(handle, processId),
    listProcesses: () => listProcesses(handle),
    exists: async (path) => {
      const sandbox = await handle.ready()
      // `test -e` rather than the vendor's `fs().exists`: the contract's `exists` answers for
      // directories as well as files, and the vendor does not document which it covers.
      const probe = await execArgv(sandbox, ['test', '-e', path])
      return { exists: probe.exitCode === 0 }
    },
    destroy: () => handle.remove(),
  }
}
