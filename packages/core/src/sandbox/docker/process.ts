/**
 * One journalled process, as the contract's {@link SandboxProcessHandle}.
 *
 * The handle is deliberately stateless beyond its id and paths: every answer is read from
 * the journal at the moment it is asked for. That is what lets `getProcess(id)` hand back a
 * working handle in a process that never started the command — including after it exited.
 */
import type {
  ProcessExit,
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

function terminalEvent(state: JournalState, processId: string): ProcessLogEvent | undefined {
  const timestamp = new Date().toISOString()
  const exit = toProcessExit(state)
  if (exit !== undefined) {
    return { type: 'terminal', state: 'exited', cursor: '', timestamp, exit }
  }
  if (state.alive) {
    return undefined
  }
  return {
    type: 'terminal',
    state: 'error',
    cursor: '',
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

/** Signal the process's whole session, so anything it spawned goes with it. */
async function kill(options: ProcessHandleOptions, signal = 15): Promise<void> {
  const state = await readJournalState(options.container, options.paths)
  if (state.pid === undefined) {
    return
  }
  // Negative pid targets the process group. `setsid` in the wrapper is what makes that group
  // the process's own rather than every command in the container.
  await execScript(
    options.container,
    `kill -${signal} -${state.pid} 2>/dev/null || kill -${signal} ${state.pid} 2>/dev/null || true`,
  )
}

async function logs(
  options: ProcessHandleOptions,
  logsOptions: ProcessLogsOptions = {},
): Promise<ReadableStream<ProcessLogEvent>> {
  const [state, liveOffsets] = await Promise.all([
    readJournalState(options.container, options.paths),
    readLiveOffsets(options.container, options.paths),
  ])

  return openLogStream({
    ...logsOptions,
    container: options.container,
    paths: options.paths,
    ...(state.pid === undefined ? {} : { wrapperPid: state.pid }),
    liveOffsets,
    terminal: async () => terminalEvent(
      await readJournalState(options.container, options.paths),
      options.processId,
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
