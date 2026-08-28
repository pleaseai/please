/**
 * One sandbox directory, as the contract's {@link SandboxSession}.
 *
 * The directory tree is acquired lazily by {@link SandboxRoot}, so a session object costs
 * nothing until a call actually needs it — which is what `SandboxProvider.session` being
 * synchronous and cheap requires.
 */
import type {
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '../contract'
import type { JournalMeta, JournalPaths } from './journal'
import type { SandboxRoot } from './root'
import { mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createLocalFiles } from './files'
import { journalPaths, wrapperArgv } from './journal'
import { createProcessHandle } from './process'
import { readJournalState, toProcessStatus } from './process-state'

/** How long `exec` waits for the wrapper to record that it started. */
const START_TIMEOUT_MS = 5_000
const START_POLL_MS = 20

/** What `status()` reports for a journal whose meta was never readable. */
const UNKNOWN_COMMAND = ['unknown'] as unknown as SandboxCommand

/**
 * Wait until the wrapper has journalled a pid — or already an exit, for a command short enough
 * to finish first.
 *
 * `Bun.spawn` returns as soon as the child exists, which says nothing about whether the shell
 * reached the line that records its pid. Returning a handle before either file exists would
 * hand the caller one whose first `status()` reports `error`, for a process that is starting
 * normally.
 */
async function waitForStart(paths: JournalPaths, processId: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    const state = await readJournalState(paths)
    if (state.pid !== undefined || state.exit !== undefined) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`process '${processId}' did not start inside the sandbox`)
    }
    await Bun.sleep(START_POLL_MS)
  }
}

/**
 * Best-effort teardown of a process whose start could not be confirmed.
 *
 * The marker goes down first, and the journal directory is deliberately left in place to carry
 * it. In the window this exists for, the wrapper has not written a pid yet — there is nothing
 * to kill, and the marker is the only thing that can stop it launching at all. Deleting the
 * directory here would delete the one instruction it is waiting to read.
 */
async function abandonStartedProcess(paths: JournalPaths): Promise<void> {
  try {
    await Bun.write(paths.abandon, '')
  }
  catch {
    // Nothing else can be done for it; the caller is already receiving the start failure.
  }
}

/**
 * Lay down the journal a process is about to write into.
 *
 * Written here rather than by the wrapper, because the host can simply write it — one less
 * thing the script has to be trusted to do before it records a pid. The two stream files are
 * created empty so a reader that opens the log before the redirect lands sees an empty file
 * rather than a missing one.
 */
async function prepareJournal(paths: JournalPaths, meta: JournalMeta): Promise<void> {
  await mkdir(paths.dir, { recursive: true })
  await Promise.all([
    Bun.write(paths.meta, JSON.stringify(meta)),
    Bun.write(paths.stdout, ''),
    Bun.write(paths.stderr, ''),
  ])
}

export interface LocalSessionOptions {
  root: SandboxRoot
  /** Resolved once by the provider, so every process in this sandbox sees the same one. */
  env: Readonly<Record<string, string>>
}

async function exec(
  options: LocalSessionOptions,
  command: SandboxCommand,
  execOptions: SandboxExecOptions = {},
): Promise<SandboxProcessHandle> {
  const { root } = options
  await root.ready()

  const processId = crypto.randomUUID()
  const paths = journalPaths(root.journalRoot, processId)
  const cwd = execOptions.cwd === undefined
    ? root.workDir
    : (isAbsolute(execOptions.cwd) ? execOptions.cwd : resolve(root.workDir, execOptions.cwd))

  const meta: JournalMeta = {
    id: processId,
    command,
    // The *resolved* directory, not what the caller passed: a later reader of this journal has
    // no way to re-resolve a relative path against a working directory it cannot see.
    cwd,
    startedAt: new Date().toISOString(),
    ...(execOptions.timeout === undefined ? {} : { timeoutMs: execOptions.timeout }),
  }

  await prepareJournal(paths, meta)

  const child = Bun.spawn(
    wrapperArgv({
      paths,
      command,
      ...(execOptions.timeout === undefined ? {} : { timeout: execOptions.timeout }),
    }),
    {
      cwd,
      env: execOptions.env === undefined ? options.env : { ...options.env, ...execOptions.env },
      stdin: 'ignore',
      // The wrapper redirects the command's own streams into the journal, so nothing here has
      // an inherited pipe to drain — and a pipe the parent held would tie the process's life
      // to the parent's, which is the thing the journal exists to avoid.
      stdout: 'ignore',
      stderr: 'ignore',
      // Leads its own process group, which is what makes the wrapper's group kill reach the
      // command's tree instead of the caller's. `setsid` buys this in the Docker backend.
      detached: true,
    },
  )
  // Detach it from this process's event loop as well: a sandbox process outliving its caller
  // is the contract, and an unreffed child is what keeps the caller free to exit.
  child.unref()

  try {
    await waitForStart(paths, processId)
  }
  catch (cause) {
    // The detached wrapper may be running even though its journal never became readable in
    // time. Rejecting without this would return no handle for a live process — nothing could
    // ever kill it, and nothing could ever read it.
    await abandonStartedProcess(paths)
    throw cause
  }
  return createProcessHandle({ processId, paths, command })
}

async function getProcess(
  options: LocalSessionOptions,
  processId: string,
): Promise<SandboxProcessHandle | null> {
  // Discovery must not create: asking whether a sandbox ever ran a process is a question, and
  // a question that stands one up has changed the thing it was asking about.
  if (await options.root.peek() === undefined) {
    return null
  }
  const paths = journalPaths(options.root.journalRoot, processId)
  const [exists, abandoned] = await Promise.all([
    Bun.file(paths.meta).exists(),
    Bun.file(paths.abandon).exists(),
  ])
  if (!exists || abandoned) {
    return null
  }

  const state = await readJournalState(paths)
  return createProcessHandle({
    processId,
    paths,
    command: state.meta?.command ?? UNKNOWN_COMMAND,
  })
}

async function listProcesses(options: LocalSessionOptions): Promise<ProcessStatus[]> {
  if (await options.root.peek() === undefined) {
    return []
  }

  let entries: string[]
  try {
    entries = (await readdir(options.root.journalRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  }
  catch {
    return []
  }

  const listed = await Promise.all(entries.map(async (id) => {
    const paths = journalPaths(options.root.journalRoot, id)
    // Abandoned journals are skipped rather than deleted. The marker is what a wrapper still
    // starting up reads to know not to launch, so removing it would reintroduce the race it
    // exists to close — but a command that never ran is not a process, and reporting it as one
    // would give every later `listProcesses()` a permanent phantom in the `error` state.
    if (await Bun.file(paths.abandon).exists()) {
      return undefined
    }
    const state = await readJournalState(paths)
    return toProcessStatus(id, state, state.meta?.command ?? UNKNOWN_COMMAND)
  }))

  return listed.filter((status): status is ProcessStatus => status !== undefined)
}

export function createLocalSession(options: LocalSessionOptions): SandboxSession {
  const { root } = options
  const files = createLocalFiles({ workDir: root.workDir })

  // Every file call resolves the sandbox first, the way the Docker backend resolves its
  // container. It is what makes a non-recursive `mkdir('logs')` work on a sandbox nothing has
  // touched yet: the parent it needs is the working directory, and `ready()` is what creates it.
  const withRoot = <Args extends unknown[], Result>(
    call: (...args: Args) => Promise<Result>,
  ) => async (...args: Args): Promise<Result> => {
    await root.ready()
    return call(...args)
  }

  return {
    readFile: withRoot(files.readFile) as SandboxSession['readFile'],
    writeFile: withRoot(files.writeFile),
    mkdir: withRoot(files.mkdir),
    exec: (command, execOptions) => exec(options, command, execOptions),
    getProcess: processId => getProcess(options, processId),
    listProcesses: () => listProcesses(options),
    exists: async (path) => {
      await root.ready()
      const resolved = isAbsolute(path) ? path : resolve(root.workDir, path)
      return { exists: await Bun.file(resolved).exists() || await isDirectory(resolved) }
    },
    destroy: () => root.remove(),
  }
}

/** `Bun.file(...).exists()` answers for files only, and a caller asking about a path means both. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)) !== undefined
  }
  catch {
    return false
  }
}
