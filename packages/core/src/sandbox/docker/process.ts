/**
 * One journalled process, as the contract's {@link SandboxProcessHandle}.
 *
 * The handle is deliberately stateless beyond its id and paths: every answer is read from
 * the journal at the moment it is asked for. That is what lets `getProcess(id)` hand back a
 * working handle in a process that never started the command — including after it exited.
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
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '../contract'
import { execScript } from './exec'
import { openLogStream } from './process-logs'
import { readJournalState, toProcessExit, toProcessStatus } from './process-state'
import { quoteArg } from './shell-quote'

/** How often a wait re-reads the journal. */
const POLL_INTERVAL_MS = 120

/** How long `kill` waits for the wrapper to reap the child before it gives up watching. */
const REAP_TIMEOUT_MS = 5_000

/** How long a followed read waits for the wrapper's pid to appear in the journal. */
const PID_TIMEOUT_MS = 1_000

/** Byte sizes of both log files, for a read that starts at the live tail. */
async function readLiveOffsets(
  container: string,
  paths: JournalPaths,
): Promise<{ stdout: number, stderr: number }> {
  const script = [
    `wc -c < ${quoteArg(paths.stdout)} 2>/dev/null || echo 0`,
    `wc -c < ${quoteArg(paths.stderr)} 2>/dev/null || echo 0`,
  ].join('\n')
  const result = await execScript(container, script)
  const [out = '0', err = '0'] = result.stdout.trim().split('\n')
  return {
    stdout: Math.max(0, Number.parseInt(out.trim(), 10) || 0),
    stderr: Math.max(0, Number.parseInt(err.trim(), 10) || 0),
  }
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

export interface ProcessHandleOptions {
  container: string
  processId: string
  paths: JournalPaths
  /** Reported by `status()` only until the journal's own meta file exists. */
  command: SandboxCommand
}

/**
 * Wait until the journal records an exit.
 *
 * A wait that ends before the process does **rejects** — with
 * {@link SandboxWaitTimeoutError} when its own budget or signal ended it, and with
 * {@link SandboxNoExitRecordError} when the process is gone and left nothing behind. It never
 * resolves a synthetic exit: every caller's `catch` is its timeout path, so resolving would
 * turn "I stopped watching" into "it is dead" and let the caller act over a live process.
 */
async function waitForExit(
  options: ProcessHandleOptions,
  waitOptions: WaitForExitOptions = {},
): Promise<ProcessExit> {
  const startedAt = Date.now()
  const expired = () => waitOptions.timeout !== undefined
    && Date.now() - startedAt >= waitOptions.timeout

  for (;;) {
    const state = await readJournalState(options.container, options.paths)
    const exit = toProcessExit(state)
    if (exit !== undefined) {
      return exit
    }

    // Re-read once before believing a disappearance: the wrapper writes its exit line and
    // then dies, so a read landing between the two sees neither a live pid nor an exit.
    if (!state.alive) {
      await Bun.sleep(POLL_INTERVAL_MS)
      const settled = await readJournalState(options.container, options.paths)
      const settledExit = toProcessExit(settled)
      if (settledExit !== undefined) {
        return settledExit
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
 * Signal the process's whole session, so anything it spawned goes with it.
 *
 * Nothing is signalled once the journal says the process is over: the pid it records is
 * historical from that moment on, and the container is free to hand it to something else.
 * Signalling it then would kill an unrelated process — or an unrelated *group*.
 *
 * The call resolves only once the wrapper has reaped the child, so a caller that awaits a
 * kill before tearing down or retrying is not racing a process that is still running.
 */
async function kill(options: ProcessHandleOptions, signal = 15): Promise<void> {
  const state = await readJournalState(options.container, options.paths)
  if (state.pid === undefined || state.exit !== undefined || !state.alive) {
    return
  }
  // Negative pid targets the process group. `setsid` in the wrapper is what makes that group
  // the process's own rather than every command in the container.
  await execScript(
    options.container,
    `kill -${signal} -${state.pid} 2>/dev/null || kill -${signal} ${state.pid} 2>/dev/null || true`,
  )
  await awaitTermination(options)
}

/** Poll until the journal reports the process over, or the budget for watching runs out. */
async function awaitTermination(options: ProcessHandleOptions): Promise<void> {
  const deadline = Date.now() + REAP_TIMEOUT_MS
  for (;;) {
    const state = await readJournalState(options.container, options.paths)
    if (state.exit !== undefined || !state.alive) {
      return
    }
    if (Date.now() >= deadline) {
      return
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

/**
 * The wrapper pid, waited for when a followed read needs one to terminate on.
 *
 * A handle resolved from an id alone can be asked for logs while the wrapper is still
 * writing its pid file. Returning immediately would start an unbounded `tail -f`.
 */
async function resolveWrapperPid(options: ProcessHandleOptions): Promise<JournalState> {
  const deadline = Date.now() + PID_TIMEOUT_MS
  for (;;) {
    const state = await readJournalState(options.container, options.paths)
    if (state.pid !== undefined || state.exit !== undefined || Date.now() >= deadline) {
      return state
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

async function logs(
  options: ProcessHandleOptions,
  logsOptions: ProcessLogsOptions = {},
): Promise<ReadableStream<ProcessLogEvent>> {
  const [state, liveOffsets] = await Promise.all([
    logsOptions.follow === true
      ? resolveWrapperPid(options)
      : readJournalState(options.container, options.paths),
    readLiveOffsets(options.container, options.paths),
  ])

  return openLogStream({
    ...logsOptions,
    container: options.container,
    paths: options.paths,
    ...(state.pid === undefined ? {} : { wrapperPid: state.pid }),
    liveOffsets,
    terminal: async cursor => terminalEvent(
      await readJournalState(options.container, options.paths),
      options.processId,
      cursor,
    ),
  })
}

async function status(options: ProcessHandleOptions): Promise<ProcessStatus> {
  return toProcessStatus(
    options.processId,
    await readJournalState(options.container, options.paths),
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
