/**
 * Reading one journalled process's state back off disk.
 *
 * The Docker backend packs every field into a single `docker exec` because each read costs a
 * round trip to the daemon. There is no daemon here, so the files are simply read — which is
 * why this file is shorter than its Docker counterpart despite answering the same question.
 */
import type { ProcessExit, ProcessStatus, SandboxCommand } from '../contract'
import type { JournalMeta, JournalPaths } from './journal'
import process from 'node:process'
import { parseExitLine, reconcileSignal } from './journal'

/** How long one identity verdict is reused. Bounds `ps` to ~one spawn per second per process. */
const IDENTITY_TTL_MS = 1_000

/** Entries kept before expired ones are swept. Only reached by a host tracking many processes. */
const IDENTITY_CACHE_LIMIT = 256

const identityCache = new Map<string, { verdict: boolean, checkedAt: number }>()

export interface JournalState {
  meta?: JournalMeta
  exit?: { code: number, signal?: number }
  pid?: number
  alive: boolean
  /** The watchdog's marker: the process was terminated for outrunning its own timeout. */
  timedOut: boolean
}

/** A journal file's contents, or `''` when it has not been written yet. */
async function readOptional(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  }
  catch {
    return ''
  }
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

function parseNumber(raw: string): number | undefined {
  const value = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(value) ? value : undefined
}

function parseMeta(raw: string): JournalMeta | undefined {
  if (raw.trim().length === 0) {
    return undefined
  }
  try {
    return JSON.parse(raw) as JournalMeta
  }
  catch {
    return undefined
  }
}

/**
 * The argv of a running process, or `undefined` when `ps` itself could not be run.
 *
 * `''` is a real answer and a different one: `ps` ran and listed nothing, so the pid is gone.
 */
async function argvOf(pid: number): Promise<string | undefined> {
  try {
    const child = Bun.spawn(['ps', '-ww', '-p', String(pid), '-o', 'args='], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [text] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return text
  }
  catch {
    return undefined
  }
}

/**
 * Whether the pid still belongs to *this* journal's wrapper.
 *
 * `wrapperArgv` puts the journal directory in the wrapper's own argv, which is what makes this
 * answerable at all: the directory is unique per process id, so an argv carrying it identifies
 * the wrapper and nothing else on the host.
 *
 * When `ps` cannot be run the answer is `true` — signal 0 already said something is there, and
 * reporting a live process dead because the tool that identifies it is missing is the worse of
 * the two errors: a caller acts on `error`/`no_exit_record` by giving up on a process that is
 * still writing.
 *
 * The verdict is cached for {@link IDENTITY_TTL_MS} because the poll loops in `./process.ts`
 * read state every 120ms and a `ps` per tick would be a subprocess spawn per tick.
 */
async function identityHolds(pid: number, journalDir: string): Promise<boolean> {
  const key = `${pid}\u0000${journalDir}`
  const now = Date.now()
  const cached = identityCache.get(key)
  if (cached !== undefined && now - cached.checkedAt < IDENTITY_TTL_MS) {
    return cached.verdict
  }

  const argv = await argvOf(pid)
  const verdict = argv === undefined ? true : argv.includes(journalDir)

  if (identityCache.size >= IDENTITY_CACHE_LIMIT) {
    for (const [staleKey, entry] of identityCache) {
      if (now - entry.checkedAt >= IDENTITY_TTL_MS) {
        identityCache.delete(staleKey)
      }
    }
  }
  identityCache.set(key, { verdict, checkedAt: now })
  return verdict
}

/**
 * Whether the wrapper is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering anything. `EPERM`
 * means the process is there and owned by someone else, which is still "alive" — only `ESRCH`
 * is an answer of no.
 *
 * **Signal 0 alone is not enough, because a pid is reused.** It is tempting to argue that
 * every caller consults `exit` first, so a reused pid could only delay a verdict — but the one
 * case that matters is exactly the case with no exit record. A wrapper `SIGKILL`ed from
 * outside never writes one, and once the host hands its pid to an unrelated process, `alive`
 * is the *only* signal left: `status()` would report `running` forever instead of `error`,
 * `waitForExit` would never reach `SandboxNoExitRecordError`, and `kill()` would send a
 * group signal to a tree that has nothing to do with this sandbox. So a positive answer is
 * confirmed against the wrapper's argv before it is believed.
 *
 * The Docker backend is genuinely narrower here — its pid space is the container's — which is
 * why this check lives in the local backend and not in `../docker/process-state.ts`.
 */
async function isAlive(pid: number | undefined, journalDir: string): Promise<boolean> {
  if (pid === undefined) {
    return false
  }
  try {
    process.kill(pid, 0)
  }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EPERM') {
      return false
    }
  }
  return identityHolds(pid, journalDir)
}

/** Attach the journalled signal to an exit line, when the two agree it was signalled. */
function withSignal(
  exit: { code: number },
  recorded: number | undefined,
): { code: number, signal?: number } {
  const signal = reconcileSignal(exit.code, recorded)
  return signal === undefined ? exit : { ...exit, signal }
}

/** Read the journal's facts. Absent files mean "not written yet", never an error. */
export async function readJournalState(paths: JournalPaths): Promise<JournalState> {
  const [meta, exit, signal, pid, timedOut] = await Promise.all([
    readOptional(paths.meta),
    readOptional(paths.exit),
    readOptional(paths.signal),
    readOptional(paths.pid),
    fileExists(paths.timeout),
  ])

  const parsedExit = parseExitLine(exit)
  const parsedPid = parseNumber(pid)

  return {
    meta: parseMeta(meta),
    ...(parsedExit === undefined ? {} : { exit: withSignal(parsedExit, parseNumber(signal)) }),
    ...(parsedPid === undefined ? {} : { pid: parsedPid }),
    alive: await isAlive(parsedPid, paths.dir),
    timedOut,
  }
}

/**
 * The journal's exit line, as the contract's {@link ProcessExit}.
 *
 * `timedOut` means the *process* was killed by its own timeout, never that a caller gave up
 * waiting — and it is read straight off the watchdog's marker file rather than inferred from
 * an exit code a command is equally free to return on its own.
 */
export function toProcessExit(state: JournalState): ProcessExit | undefined {
  if (state.exit === undefined) {
    return undefined
  }
  return { ...state.exit, timedOut: state.timedOut }
}

/**
 * Turn the journal's facts into the contract's {@link ProcessStatus}.
 *
 * The `error` state is what a process that vanished without journalling an exit becomes —
 * `SIGKILL`ed by someone else, or the machine rebooted underneath it. Reporting that as
 * `exited` with an invented code would tell the caller the process finished, which is the one
 * thing that is known not to have happened.
 */
export function toProcessStatus(
  processId: string,
  state: JournalState,
  fallbackCommand: SandboxCommand,
): ProcessStatus {
  const base = {
    id: processId,
    pid: state.pid ?? 0,
    command: state.meta?.command ?? fallbackCommand,
    ...(state.meta?.cwd === undefined ? {} : { cwd: state.meta.cwd }),
    startedAt: state.meta?.startedAt ?? new Date(0).toISOString(),
  }

  const exit = toProcessExit(state)
  if (exit !== undefined) {
    return { ...base, state: 'exited', exit, endedAt: new Date().toISOString() }
  }
  if (state.alive) {
    return { ...base, state: 'running' }
  }

  return {
    ...base,
    state: 'error',
    error: {
      code: 'no_exit_record',
      message: `process '${processId}' is no longer running and journalled no exit code`,
    },
    endedAt: new Date().toISOString(),
  }
}
