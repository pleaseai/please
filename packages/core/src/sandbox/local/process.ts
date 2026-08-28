/**
 * One journalled process, as the contract's {@link SandboxProcessHandle}.
 *
 * The handle is deliberately stateless beyond its id and paths: every answer is read from the
 * journal at the moment it is asked for, never from a child handle held in memory. That is
 * what lets `getProcess(id)` hand back a working handle in a host process that never started
 * the command — including one started before the last restart, and including after it exited.
 */
import type {
  ProcessExit,
  ProcessLogCursor,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessStatus,
  SandboxCommand,
  SandboxProcessHandle,
  WaitForExitOptions,
} from '../contract'
import type { JournalPaths } from './journal'
import type { JournalState } from './process-state'
import { constants } from 'node:os'
import process from 'node:process'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '../contract'
import { openLogStream, readLiveOffsets } from './process-logs'
import { readJournalState, toProcessExit, toProcessStatus } from './process-state'

/** How often a wait re-reads the journal. */
const POLL_INTERVAL_MS = 50

/** How long `kill` waits for the wrapper to reap the child before it gives up watching. */
const REAP_TIMEOUT_MS = 5_000

const SIGKILL = constants.signals.SIGKILL

export interface ProcessHandleOptions {
  processId: string
  paths: JournalPaths
  /** Reported by `status()` only until the journal's own meta file exists. */
  command: SandboxCommand
}

/**
 * The event that closes a log stream.
 *
 * It carries the offsets the stream actually reached, not an empty cursor: a caller resuming
 * from the last event it saw would otherwise be told position zero and replay the whole log.
 */
function terminalEvent(
  state: JournalState,
  processId: string,
  cursor: ProcessLogCursor,
): ProcessLogEvent | undefined {
  const timestamp = new Date().toISOString()
  const exit = toProcessExit(state)
  if (exit !== undefined) {
    return { type: 'terminal', state: 'exited', cursor, timestamp, exit }
  }
  if (state.alive) {
    return undefined
  }
  return {
    type: 'terminal',
    state: 'error',
    cursor,
    timestamp,
    error: {
      code: 'no_exit_record',
      message: `process '${processId}' is no longer running and journalled no exit code`,
    },
  }
}

/**
 * Hold an exit record back until the group it describes is actually gone.
 *
 * The wrapper's escalation writes its exit record *before* `kill -9 -$wrapper`, and has to:
 * the wrapper dies with the group it is killing, so a record written afterwards would never be
 * written at all (`./journal.ts` says the same at the line that writes it). The cost is a
 * window in which the journal reads as finished while the tree is still up — and a caller that
 * returned there would be free to delete the working directory, or start a retry, over
 * processes still running in it.
 *
 * Only the escalation's own record waits. `signal === SIGKILL` is written by nothing else —
 * an uncatchable signal leaves no record when it arrives from outside — so an ordinary exit,
 * which is every exit in the common case, still returns on the first read.
 */
async function settle(options: ProcessHandleOptions, exit: ProcessExit): Promise<ProcessExit> {
  if (exit.signal === SIGKILL) {
    await awaitGroupExit(options)
  }
  return exit
}

/** Poll until the wrapper's pid is gone, or the budget for watching runs out. */
async function awaitGroupExit(options: ProcessHandleOptions): Promise<void> {
  const deadline = Date.now() + REAP_TIMEOUT_MS
  for (;;) {
    if (!(await readJournalState(options.paths)).alive) {
      return
    }
    if (Date.now() >= deadline) {
      return
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Wait until the journal records an exit.
 *
 * A wait that ends before the process does **rejects** — with {@link SandboxWaitTimeoutError}
 * when its own budget or signal ended it, and with {@link SandboxNoExitRecordError} when the
 * process is gone and left nothing behind. It never resolves a synthetic exit: every caller's
 * `catch` is its timeout path, so resolving would turn "I stopped watching" into "it is dead"
 * and let the caller act over a process that is still running.
 */
async function waitForExit(
  options: ProcessHandleOptions,
  waitOptions: WaitForExitOptions = {},
): Promise<ProcessExit> {
  const startedAt = Date.now()
  const expired = () => waitOptions.timeout !== undefined
    && Date.now() - startedAt >= waitOptions.timeout

  for (;;) {
    const state = await readJournalState(options.paths)
    const exit = toProcessExit(state)
    if (exit !== undefined) {
      return settle(options, exit)
    }

    // Re-read once before believing a disappearance: the wrapper writes its exit line and then
    // dies, so a read landing between the two sees neither a live pid nor an exit.
    if (!state.alive) {
      await Bun.sleep(POLL_INTERVAL_MS)
      const settled = await readJournalState(options.paths)
      const settledExit = toProcessExit(settled)
      if (settledExit !== undefined) {
        return settle(options, settledExit)
      }
      if (!settled.alive) {
        throw new SandboxNoExitRecordError(options.processId)
      }
    }

    if (waitOptions.signal?.aborted === true || expired()) {
      throw new SandboxWaitTimeoutError(options.processId, Date.now() - startedAt)
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Signal the process's whole group, so anything it spawned goes with it.
 *
 * Nothing is signalled once the journal says the process is over: the pid it records is
 * historical from that moment on, and the host is free to hand it to something else. Signalling
 * it then would kill an unrelated process — or, since this is a *group* signal and this backend
 * shares its pid space with everything else on the machine, an unrelated tree.
 *
 * The call resolves only once the wrapper has reaped the child, so a caller that awaits a kill
 * before tearing down or retrying is not racing a process that is still running.
 */
async function kill(options: ProcessHandleOptions, signal = 15): Promise<void> {
  const state = await readJournalState(options.paths)
  if (state.pid === undefined || state.exit !== undefined || !state.alive) {
    return
  }
  const pid = state.pid
  try {
    // A negative pid targets the process group. The wrapper leads one of its own because it is
    // spawned detached, which is what keeps this from reaching anything else on the host.
    process.kill(-pid, signal)
  }
  catch {
    // The group is gone, or the wrapper never led one. Falling back to the pid alone still
    // stops the wrapper; a `SIGKILL`ed wrapper leaves the no-exit-record state, which is the
    // honest report of a process nothing observed finishing.
    try {
      process.kill(pid, signal)
    }
    catch {
      return
    }
  }
  await awaitTermination(options)
}

/** Poll until the journal reports the process over, or the budget for watching runs out. */
async function awaitTermination(options: ProcessHandleOptions): Promise<void> {
  const deadline = Date.now() + REAP_TIMEOUT_MS
  for (;;) {
    const state = await readJournalState(options.paths)
    if (state.exit !== undefined || !state.alive) {
      return
    }
    if (Date.now() >= deadline) {
      return
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

async function logs(
  options: ProcessHandleOptions,
  logsOptions: ProcessLogsOptions = {},
): Promise<ReadableStream<ProcessLogEvent>> {
  const liveOffsets = await readLiveOffsets(options.paths)

  return openLogStream({
    ...logsOptions,
    paths: options.paths,
    liveOffsets,
    isRunning: async () => {
      const state = await readJournalState(options.paths)
      return state.exit === undefined && state.alive
    },
    terminal: async cursor => terminalEvent(
      await readJournalState(options.paths),
      options.processId,
      cursor,
    ),
  })
}

async function status(options: ProcessHandleOptions): Promise<ProcessStatus> {
  return toProcessStatus(
    options.processId,
    await readJournalState(options.paths),
    options.command,
  )
}

export function createProcessHandle(options: ProcessHandleOptions): SandboxProcessHandle {
  return {
    id: options.processId,
    status: () => status(options),
    logs: logsOptions => logs(options, logsOptions),
    waitForExit: waitOptions => waitForExit(options, waitOptions),
    kill: signal => kill(options, signal),
  }
}
