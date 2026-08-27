/**
 * One container, as the contract's {@link SandboxSession}.
 *
 * The container is acquired lazily by {@link ContainerHandle}, so a session object costs
 * nothing until a call actually needs the daemon — which is what `SandboxProvider.session`
 * being synchronous and cheap requires.
 */
import type {
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '../contract'
import type { ContainerHandle } from './container'
import type { JournalMeta } from './journal'
import { execInContainer, execScript } from './exec'
import { createDockerFiles } from './files'
import { JOURNAL_ROOT, journalledCommand, journalPaths } from './journal'
import { createProcessHandle } from './process'
import { readJournalState, toProcessStatus } from './process-state'
import { quoteArg } from './shell-quote'

/** How long `exec` waits for the wrapper to record that it started. */
const START_TIMEOUT_MS = 5_000
const START_POLL_MS = 50

/**
 * Wait until the wrapper has journalled a pid — or already an exit, for a command short
 * enough to finish first.
 *
 * `docker exec --detach` returns as soon as the daemon has created the exec, which says
 * nothing about whether the wrapper ran. Returning a handle before either file exists would
 * hand the caller one whose first `status()` reports `error`, for a process that is starting
 * normally.
 */
async function waitForStart(
  container: string,
  paths: ReturnType<typeof journalPaths>,
  processId: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    const state = await readJournalState(container, paths)
    if (state.pid !== undefined || state.exit !== undefined) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`process '${processId}' did not start inside the sandbox`)
    }
    await Bun.sleep(START_POLL_MS)
  }
}

async function exec(
  handle: ContainerHandle,
  command: SandboxCommand,
  options: SandboxExecOptions = {},
): Promise<SandboxProcessHandle> {
  const container = await handle.ready()
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
  const started = await execScript(container, script, {
    detach: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  if (started.exitCode !== 0) {
    throw new Error(`starting a process failed (exit ${started.exitCode}): ${started.stderr.trim()}`)
  }

  try {
    await waitForStart(container, paths, processId)
  }
  catch (cause) {
    // The detached wrapper may be running even though its journal never became readable in
    // time. Rejecting without this would return no handle for a live process — nothing
    // could ever kill it, and nothing could ever read it.
    await abandonStartedProcess(container, paths)
    throw cause
  }
  return createProcessHandle({ container, processId, paths, command })
}

/** Best-effort teardown of a process whose start could not be confirmed. */
async function abandonStartedProcess(
  container: string,
  paths: ReturnType<typeof journalPaths>,
): Promise<void> {
  // The marker goes down first, and the journal directory is deliberately left in place to
  // carry it. In the window this exists for, the wrapper has not written a pid yet — there
  // is nothing to kill, and the marker is the only thing that can stop it launching at all.
  // Deleting the directory here would delete the one instruction it is waiting to read.
  const script = [
    `mkdir -p ${quoteArg(paths.dir)}`,
    `: > ${quoteArg(paths.abandon)}`,
    `pid=$(cat ${quoteArg(paths.pid)} 2>/dev/null)`,
    'if [ -n "$pid" ] ; then kill -9 "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null ; fi',
  ].join('\n')
  await execScript(container, script).catch(() => undefined)
}

async function getProcess(
  handle: ContainerHandle,
  processId: string,
): Promise<SandboxProcessHandle | null> {
  // Discovery must not create: asking whether a sandbox ever ran a process is a question,
  // and a question that stands up a container has changed the thing it was asking about.
  const container = await handle.peek()
  if (container === undefined) {
    return null
  }
  const paths = journalPaths(processId)
  const probe = await execInContainer(container, ['test', '-d', paths.dir])
  if (probe.exitCode !== 0) {
    return null
  }

  const state = await readJournalState(container, paths)
  return createProcessHandle({
    container,
    processId,
    paths,
    command: state.meta?.command ?? (['unknown'] as unknown as SandboxCommand),
  })
}

async function listProcesses(handle: ContainerHandle): Promise<ProcessStatus[]> {
  const container = await handle.peek()
  if (container === undefined) {
    return []
  }
  const listing = await execScript(container, `ls -1 ${JOURNAL_ROOT} 2>/dev/null || true`)
  const ids = listing.stdout.split('\n').map(id => id.trim()).filter(id => id.length > 0)

  return Promise.all(ids.map(async (id) => {
    const state = await readJournalState(container, journalPaths(id))
    return toProcessStatus(id, state, state.meta?.command ?? (['unknown'] as unknown as SandboxCommand))
  }))
}

export interface DockerSessionOptions {
  container: ContainerHandle
}

export function createDockerSession(options: DockerSessionOptions): SandboxSession {
  const { container: handle } = options

  // The file surface needs a container name, which is only known once acquired. Each call
  // resolves it, so nothing is created until one is made.
  const files = {
    readFile: async (path: string, fileOptions?: { encoding?: never }) =>
      createDockerFiles(await handle.ready()).readFile(path, fileOptions),
    writeFile: async (
      path: string,
      content: string | ReadableStream<Uint8Array>,
      fileOptions?: { encoding?: never },
    ) => createDockerFiles(await handle.ready()).writeFile(path, content, fileOptions),
    mkdir: async (path: string, fileOptions?: { recursive?: boolean }) =>
      createDockerFiles(await handle.ready()).mkdir(path, fileOptions),
  } as unknown as Pick<SandboxSession, 'readFile' | 'writeFile' | 'mkdir'>

  return {
    ...files,
    exec: (command, execOptions) => exec(handle, command, execOptions),
    getProcess: processId => getProcess(handle, processId),
    listProcesses: () => listProcesses(handle),
    exists: async (path) => {
      const container = await handle.ready()
      const probe = await execInContainer(container, ['test', '-e', path])
      return { exists: probe.exitCode === 0 }
    },
    destroy: () => handle.remove(),
  }
}
