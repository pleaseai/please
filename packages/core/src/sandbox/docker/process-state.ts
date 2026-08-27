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
import { parseExitLine, TIMEOUT_EXIT_CODE } from './journal'
import { quoteArg } from './shell-quote'

/** Separator between fields of the status script's output. Not valid inside any of them. */
const FIELD = ' -- '

export interface JournalState {
  meta?: JournalMeta
  exit?: { code: number, signal?: number }
  pid?: number
  alive: boolean
}

/** One shell script reading meta, exit, pid and liveness in a single round trip. */
function statusScript(paths: JournalPaths): string {
  const separator = `printf '%s' ${quoteArg(FIELD)}`
  const liveness = `if kill -0 "$(cat ${quoteArg(paths.pid)} 2>/dev/null)" 2>/dev/null ; then `
    + 'printf alive ; fi'

  return [
    `cat ${quoteArg(paths.meta)} 2>/dev/null`,
    separator,
    `cat ${quoteArg(paths.exit)} 2>/dev/null`,
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

/** Read the journal's four facts. Absent files mean "not written yet", never an error. */
export async function readJournalState(
  container: string,
  paths: JournalPaths,
  abortSignal?: AbortSignal,
): Promise<JournalState> {
  const result = await execScript(container, statusScript(paths), { abortSignal })
  const [meta = '', exit = '', pid = '', alive = ''] = result.stdout.split(FIELD)
  const parsedPid = Number.parseInt(pid.trim(), 10)

  return {
    meta: parseMeta(meta),
    exit: parseExitLine(exit),
    pid: Number.isInteger(parsedPid) ? parsedPid : undefined,
    alive: alive.trim() === 'alive',
  }
}

/**
 * The journal's exit line, as the contract's {@link ProcessExit}.
 *
 * `timedOut` means the *process* was killed by its own timeout, never that a caller gave up
 * waiting. Only a command that was actually wrapped in `timeout` can produce it, so the flag
 * is the conjunction of two facts the journal records separately: that a timeout was asked
 * for, and that the exit code is the one GNU `timeout` reserves for having fired.
 */
export function toProcessExit(state: JournalState): ProcessExit | undefined {
  if (state.exit === undefined) {
    return undefined
  }
  return {
    ...state.exit,
    timedOut: state.meta?.timeoutMs !== undefined && state.exit.code === TIMEOUT_EXIT_CODE,
  }
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
