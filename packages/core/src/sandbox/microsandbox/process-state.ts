/**
 * Reading one journalled process's state back out of the guest.
 *
 * The journal itself is `../docker/journal.ts` — see `./session.ts` for why that module is
 * shared rather than copied. What differs here is how it is *read*, and the difference is worth
 * the separate file: this backend has a real filesystem API alongside its exec channel, so the
 * two halves of the journal are read the way each is cheapest.
 *
 * - **The five shell-produced facts** — exit, signal, timeout marker, pid, liveness — come from
 *   one script, because liveness is `kill -0` and cannot be answered by reading a file at all,
 *   and because a `waitForExit` poll asks for exactly these and nothing else. One round trip per
 *   poll is the whole point.
 * - **`meta`** is read separately, through the filesystem. It carries caller content — argv, a
 *   working directory — so folding it into the script's output would need a separator no path or
 *   argument could contain. `status()` is the only caller that wants it, and it is written once
 *   at launch, so a second call there costs less than that ambiguity.
 */
import type { ProcessExit, ProcessStatus, SandboxCommand } from '../contract'
import type { JournalMeta, JournalPaths } from '../docker/journal'
import type { MicroSandbox } from './runtime'
import { parseExitLine, reconcileSignal } from '../docker/journal'
import { quoteArg } from '../docker/shell-quote'
import { execScript } from './guest'

/**
 * Separator between the script's fields.
 *
 * A single printable character is safe here in a way it would not be for `meta`: every field
 * around it is shell-produced — an integer, one of two fixed words, or nothing — so none of them
 * can contain it. `../docker/process-state.ts` needs a more careful scheme precisely because it
 * puts `meta` in the same stream; this file reads `meta` elsewhere and does not.
 */
const FIELD = '|'

export interface JournalState {
  meta?: JournalMeta
  exit?: { code: number, signal?: number }
  pid?: number
  alive: boolean
  /** The watchdog's marker: the process was terminated for outrunning its own timeout. */
  timedOut: boolean
}

/** One shell script reading every journalled fact that only a shell can answer. */
function statusScript(paths: JournalPaths): string {
  const separator = `printf '%s' ${quoteArg(FIELD)}`
  return [
    `cat ${quoteArg(paths.exit)} 2>/dev/null`,
    separator,
    `cat ${quoteArg(paths.signal)} 2>/dev/null`,
    separator,
    `if [ -e ${quoteArg(paths.timeout)} ] ; then printf timedout ; fi`,
    separator,
    `cat ${quoteArg(paths.pid)} 2>/dev/null`,
    separator,
    `if kill -0 "$(cat ${quoteArg(paths.pid)} 2>/dev/null)" 2>/dev/null ; then printf alive ; fi`,
  ].join('\n')
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

/**
 * Read the journal's shell-answerable facts. Absent files mean "not written yet", never an error.
 *
 * `meta` is left unset by this call — {@link readJournalMeta} is the other half, and only the
 * callers that report a command need it.
 */
export async function readJournalState(
  sandbox: MicroSandbox,
  paths: JournalPaths,
): Promise<JournalState> {
  const result = await execScript(sandbox, statusScript(paths))
  const [exit = '', signal = '', timedOut = '', pid = '', alive = ''] = result.stdout.split(FIELD)
  const parsedExit = parseExitLine(exit)
  const parsedPid = parseNumber(pid)

  return {
    ...(parsedExit === undefined ? {} : { exit: withSignal(parsedExit, parseNumber(signal)) }),
    ...(parsedPid === undefined ? {} : { pid: parsedPid }),
    alive: alive.trim() === 'alive',
    timedOut: timedOut.trim() === 'timedout',
  }
}

/** The journal's `meta` record, read through the filesystem. Absent or unparsable is `undefined`. */
export async function readJournalMeta(
  sandbox: MicroSandbox,
  paths: JournalPaths,
): Promise<JournalMeta | undefined> {
  try {
    const bytes = await sandbox.fs().read(paths.meta)
    return JSON.parse(new TextDecoder().decode(bytes)) as JournalMeta
  }
  catch {
    return undefined
  }
}

/** Both halves, for the callers that report a command as well as a state. */
export async function readFullJournalState(
  sandbox: MicroSandbox,
  paths: JournalPaths,
): Promise<JournalState> {
  const [state, meta] = await Promise.all([
    readJournalState(sandbox, paths),
    readJournalMeta(sandbox, paths),
  ])
  return meta === undefined ? state : { ...state, meta }
}

/**
 * The journal's exit line, as the contract's {@link ProcessExit}.
 *
 * `timedOut` means the *process* was killed by its own timeout, never that a caller gave up
 * waiting — and it is read straight off the watchdog's marker file rather than inferred from an
 * exit code a command is equally free to return on its own.
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
 * The `error` state is what a process that vanished without journalling an exit becomes — killed
 * by the kernel, or its microVM stopped underneath it. Reporting that as `exited` with an
 * invented code would tell the caller the process finished, which is the one thing that is known
 * not to have happened.
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
