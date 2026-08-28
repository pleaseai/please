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
import { mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createLocalFiles } from './files'
import { isJournalId, journalPaths, wrapperArgv } from './journal'
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
 *
 * It covers a spawn that never happened at all — a `cwd` the host does not have, a `sh` it
 * cannot posix_spawn — for the second half of the same reason: the journal is already on disk
 * by then, and a journal with no wrapper behind it is what `listProcesses()` would otherwise
 * report forever as a process in the `error` state.
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

  const spawnAndConfirm = async (): Promise<void> => {
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
    await waitForStart(paths, processId)
  }

  try {
    // The spawn is inside the guard, not only the wait. `Bun.spawn` throws outright for a `cwd`
    // the host does not have, and the journal is already on disk by then — so without this the
    // failed call would leave a journal nothing can ever resolve, which every later
    // `listProcesses()` reports as a process permanently in the `error` state.
    await spawnAndConfirm()
  }
  catch (cause) {
    // The detached wrapper may also be running even though its journal never became readable in
    // time. Rejecting without this would return no handle for a live process — nothing could
    // ever kill it, and nothing could ever read it.
    await abandonStartedProcess(paths)
    throw cause
  }
  return createProcessHandle({ processId, paths, command })
}

/**
 * Whether the wrapper behind this journal ever actually ran.
 *
 * Discovery is gated on the wrapper's own record — a pid, or an exit for a command that
 * finished before anything read it — rather than on the journal directory existing. The two
 * are not the same here the way they are in `../docker`, whose wrapper creates its own
 * directory: `prepareJournal` writes `meta` from the host *before* the spawn, so between that
 * write and the wrapper's first line the journal is a directory with a command in it and
 * nothing behind it. Reported by state alone that reads as `error`/`no_exit_record`, which
 * would tell a caller a perfectly healthy process had failed — a `listProcesses()` racing an
 * `exec()` that is still starting is enough to see it.
 *
 * A process not yet listed is the honest answer for that window: `exec` has not returned a
 * handle for it either. And nothing is hidden permanently — a wrapper that ran writes its pid
 * within milliseconds, and one that never ran is what {@link abandonStartedProcess} marks.
 */
function hasLaunched(state: { pid?: number, exit?: unknown }): boolean {
  return state.pid !== undefined || state.exit !== undefined
}

async function getProcess(
  options: LocalSessionOptions,
  processId: string,
): Promise<SandboxProcessHandle | null> {
  // An id that cannot name a journal names no process. Rejected before it is joined onto
  // `journalRoot`, so a path-shaped id reads nothing rather than reading outside the tree —
  // see `isJournalId` in `./journal.ts`.
  if (!isJournalId(processId)) {
    return null
  }
  // Discovery must not create: asking whether a sandbox ever ran a process is a question, and
  // a question that stands one up has changed the thing it was asking about.
  if (await options.root.peek() === undefined) {
    return null
  }
  const paths = journalPaths(options.root.journalRoot, processId)
  if (await Bun.file(paths.abandon).exists()) {
    return null
  }

  const state = await readJournalState(paths)
  if (!hasLaunched(state)) {
    return null
  }
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
    if (!hasLaunched(state)) {
      return undefined
    }
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
      return { exists: await pathExists(resolved) }
    },
    destroy: () => root.remove(),
  }
}

/**
 * Whether anything at all is at the path.
 *
 * `stat` rather than `Bun.file(...).exists()`, which answers for files only, and rather than a
 * `readdir` probe for the directory half: listing a directory to decide whether it is there
 * reads every entry in it to answer a question about one path, and it answers *no* for a
 * directory the caller may traverse but not list — a path that plainly exists.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}
