/**
 * One `just-bash` command, as the contract's {@link SandboxProcessHandle}.
 *
 * The vendor's `Command` already carries most of the surface — `logs()`, `wait()`, `kill()` —
 * so this file is mostly translation. Two things it does not carry, and this does:
 *
 * **Why a command ended.** `just-bash` reports every cancellation as exit code 124, GNU
 * `timeout`'s convention, whether the caller killed it or its own budget expired. That is the
 * ambiguity `../docker/journal.ts` refuses to read an exit code for, and the answer here is the
 * same in a different form: the timeout is *this* file's `AbortController` and its timer, so
 * `timedOut` is set from whether that timer fired rather than from the code the shell returned.
 *
 * **A wait that ends before the process does.** The vendor's `wait()` has no timeout, and the
 * contract requires a bounded one to reject rather than resolve — every caller's `catch` is its
 * timeout path, so a synthetic exit would let it act over a command that is still running.
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
import type { JustBashCommand } from './runtime'
import { SandboxWaitTimeoutError } from '../contract'

/** What one exec remembers beyond the vendor's own handle. */
export interface ProcessRecord {
  command: JustBashCommand
  argv: SandboxCommand
  cwd: string
  startedAt: string
  /** Set by the timeout this backend owns — never inferred from the exit code. */
  timedOut: () => boolean
  /** Ends the command's own timeout timer once it has settled. */
  settle: () => void
}

function toExit(record: ProcessRecord, code: number): ProcessExit {
  return { code, timedOut: record.timedOut() }
}

/**
 * Collect the vendor's output messages into contract events.
 *
 * A cursor is the number of messages already delivered. It is opaque by contract, and this is
 * the shape it takes for a backend whose log is a list rather than a byte stream — there is no
 * file to take an offset into, and `logs()` re-reads the same list every time.
 *
 * The list is short: the vendor coalesces a command's output into **one message per stream**,
 * so `echo one ; echo two` arrives as a single `stdout` message carrying both lines. A cursor
 * therefore advances in units far coarser than the byte offsets `../docker` and `../local` hand
 * back — still monotonic and still opaque, but not a fine-grained resume point.
 */
async function collect(record: ProcessRecord): Promise<ProcessLogEvent[]> {
  const events: ProcessLogEvent[] = []
  const encoder = new TextEncoder()
  let index = 0
  for await (const message of record.command.logs()) {
    index += 1
    events.push({
      type: message.type,
      cursor: String(index),
      timestamp: message.timestamp.toISOString(),
      data: encoder.encode(message.data),
    })
  }
  return events
}

function parseCursor(cursor: string | undefined): number {
  const value = Number.parseInt(cursor ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * Open the log as a stream of contract events.
 *
 * `follow` is accepted and does nothing, because there is nothing to follow: `just-bash` buffers
 * a command's output and delivers all of it when the command ends — measured, with
 * `echo first ; sleep 1 ; echo second` arriving as one batch at the one-second mark. A caller
 * streaming a long turn to watch it progress gets everything at the end here, which is a reason
 * to choose a different backend rather than something this one can paper over.
 *
 * `replay` is likewise always in effect: the vendor's `logs()` re-reads the whole list on every
 * call, so a read without it cannot start at a live tail that does not exist.
 */
async function logs(
  record: ProcessRecord,
  options: ProcessLogsOptions = {},
): Promise<ReadableStream<ProcessLogEvent>> {
  const events = await collect(record)
  const from = parseCursor(options.since)
  const pending = events.slice(from)
  const code = record.command.exitCode

  return new ReadableStream<ProcessLogEvent>({
    start: (controller) => {
      if (options.signal?.aborted === true) {
        controller.close()
        return
      }
      for (const event of pending) {
        controller.enqueue(event)
      }
      if (code !== undefined) {
        controller.enqueue({
          type: 'terminal',
          state: 'exited',
          cursor: String(events.length),
          timestamp: new Date().toISOString(),
          exit: toExit(record, code),
        })
      }
      controller.close()
    },
  })
}

async function waitForExit(
  record: ProcessRecord,
  options: WaitForExitOptions = {},
): Promise<ProcessExit> {
  const startedAt = Date.now()
  const finished = record.command.wait().then((result) => {
    record.settle()
    return toExit(record, result.exitCode)
  })

  if (options.timeout === undefined && options.signal === undefined) {
    return finished
  }

  // The wait is bounded, never the command: an expired wait rejects and leaves the command
  // running, which is what the caller's `catch` is written against.
  return new Promise<ProcessExit>((resolve, reject) => {
    let done = false
    const expire = () => {
      if (!done) {
        done = true
        reject(new SandboxWaitTimeoutError(record.command.cmdId, Date.now() - startedAt))
      }
    }
    const timer = options.timeout === undefined
      ? undefined
      : setTimeout(expire, options.timeout)
    if (options.signal?.aborted === true) {
      expire()
    }
    options.signal?.addEventListener('abort', expire, { once: true })

    finished.then(
      (exit) => {
        if (!done) {
          done = true
          resolve(exit)
        }
      },
      (cause: unknown) => {
        if (!done) {
          done = true
          reject(cause instanceof Error ? cause : new Error(String(cause)))
        }
      },
    ).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      options.signal?.removeEventListener('abort', expire)
    })
  })
}

export function toProcessStatus(processId: string, record: ProcessRecord): ProcessStatus {
  const base = {
    id: processId,
    // The contract types `pid` as a number and a virtual command has none. Zero is the same
    // stand-in `../local` uses for a process whose pid is not yet known — there is no honest
    // number to report, and inventing one would suggest the host could signal it.
    pid: 0,
    command: record.argv,
    cwd: record.cwd,
    startedAt: record.startedAt,
  }
  const code = record.command.exitCode
  return code === undefined
    ? { ...base, state: 'running' }
    : { ...base, state: 'exited', exit: toExit(record, code), endedAt: new Date().toISOString() }
}

export function createProcessHandle(processId: string, record: ProcessRecord): SandboxProcessHandle {
  return {
    id: processId,
    status: async () => toProcessStatus(processId, record),
    logs: options => logs(record, options),
    waitForExit: options => waitForExit(record, options),
    // The vendor's `kill()` takes no signal, so the contract's number is accepted and dropped:
    // there is no process to deliver it to, only an interpreter loop to stop.
    kill: async () => record.command.kill(),
  }
}
