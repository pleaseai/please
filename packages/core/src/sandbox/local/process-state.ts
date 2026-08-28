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
 * Whether the wrapper is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering anything. `EPERM`
 * means the process is there and owned by someone else, which is still "alive" — only `ESRCH`
 * is an answer of no.
 *
 * **This is a pid check, and a pid can be reused.** The window is the one between the wrapper
 * dying and its exit line landing, because writing that line is the wrapper's last act — and
 * every caller here consults `exit` first, so a reused pid can at worst delay a verdict by one
 * poll rather than fabricate one. Running inside a container narrows the same window for the
 * Docker backend; on a host it is narrow rather than closed.
 */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  }
  catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
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
    alive: isAlive(parsedPid),
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
