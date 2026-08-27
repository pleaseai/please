/**
 * Reading one journalled process's state back out of the container.
 *
 * Every field `status()` needs is fetched in a single `docker exec`, because each one costs
 * a round trip to the daemon and a status read that took four would be the dominant cost of
 * polling a wait.
 */
import type { ProcessExit, ProcessStatus, SandboxCommand } from '../contract'
import type { JournalMeta, JournalPaths } from './journal'
import { execScript } from './exec'
import { parseExitLine, reconcileSignal } from './journal'
import { quoteArg } from './shell-quote'

/** Separator between fields of the status script's output. */
const FIELD = ' -- '

/**
 * Fields the script emits after `meta`: exit, signal, timeout, pid, liveness.
 *
 * Only `meta` can contain arbitrary caller content — it carries argv and a working directory,
 * either of which may hold the separator — so it is the one field that is not split on. The
 * trailing five are shell-produced tokens that cannot, and they are counted from the right.
 */
const TRAILING_FIELDS = 5

export interface JournalState {
  meta?: JournalMeta
  exit?: { code: number, signal?: number }
  pid?: number
  alive: boolean
  /** The watchdog's marker: the process was terminated for outrunning its own timeout. */
  timedOut: boolean
}

/** One shell script reading every journalled fact in a single round trip. */
function statusScript(paths: JournalPaths): string {
  const separator = `printf '%s' ${quoteArg(FIELD)}`
  const liveness = `if kill -0 "$(cat ${quoteArg(paths.pid)} 2>/dev/null)" 2>/dev/null ; then `
    + 'printf alive ; fi'
  const timedOut = `if [ -e ${quoteArg(paths.timeout)} ] ; then printf timedout ; fi`

  return [
    `cat ${quoteArg(paths.meta)} 2>/dev/null`,
    separator,
    `cat ${quoteArg(paths.exit)} 2>/dev/null`,
    separator,
    `cat ${quoteArg(paths.signal)} 2>/dev/null`,
    separator,
    timedOut,
    separator,
    `cat ${quoteArg(paths.pid)} 2>/dev/null`,
    separator,
    liveness,
  ].join('\n')
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

/** Split the script's output into `meta` and its five fixed trailing fields. */
function splitFields(stdout: string): { meta: string, trailing: string[] } {
  const parts = stdout.split(FIELD)
  if (parts.length <= TRAILING_FIELDS) {
    return { meta: '', trailing: parts }
  }
  return {
    meta: parts.slice(0, parts.length - TRAILING_FIELDS).join(FIELD),
    trailing: parts.slice(-TRAILING_FIELDS),
  }
}

function parseNumber(raw: string): number | undefined {
  const value = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(value) ? value : undefined
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
export async function readJournalState(
  container: string,
  paths: JournalPaths,
  abortSignal?: AbortSignal,
): Promise<JournalState> {
  const result = await execScript(container, statusScript(paths), { abortSignal })
  const { meta, trailing } = splitFields(result.stdout)
  const [exit = '', signal = '', timedOut = '', pid = '', alive = ''] = trailing
  const parsedExit = parseExitLine(exit)
  const parsedPid = parseNumber(pid)

  return {
    meta: parseMeta(meta),
    ...(parsedExit === undefined ? {} : { exit: withSignal(parsedExit, parseNumber(signal)) }),
    ...(parsedPid === undefined ? {} : { pid: parsedPid }),
    alive: alive.trim() === 'alive',
    timedOut: timedOut.trim() === 'timedout',
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
 * killed by the kernel, or its container restarted underneath it. Reporting that as `exited`
 * with an invented code would tell the caller the process finished, which is the one thing
 * that is known not to have happened.
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
