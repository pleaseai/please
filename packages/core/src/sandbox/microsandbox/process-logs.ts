/**
 * A process's log, read back out of its journal files.
 *
 * Both streams are followed with `tail --pid=<wrapper>`, which is what ends the read when the
 * process ends: the wrapper writes its exit line and dies, `tail` flushes what is left and exits
 * on its own. Polling for the exit file instead would either truncate the tail of the output or
 * keep the reader alive after the process was gone.
 *
 * The vendor's own `logStream` was considered for this and does not fit. It reads the runtime's
 * `exec.log`, which is durable and cursor-resumable — but its entries are correlated by the
 * runtime's `sessionId`, and an `ExecHandle` never exposes the session id it was given. There is
 * no way to ask it for *this* process's output, and a backend that returned another process's
 * bytes would be worse than one that reads its own files.
 *
 * A cursor is `<stdout-bytes>:<stderr-bytes>` — how much of each file the caller has already
 * seen. It is opaque by contract, and this is the shape it happens to take.
 */
import type { ProcessLogCursor, ProcessLogEvent, ProcessLogsOptions } from '../contract'
import type { JournalPaths } from '../docker/journal'
import type { GuestProcess } from './guest'
import type { MicroSandbox } from './runtime'
import { spawnArgv } from './guest'

interface Offsets {
  stdout: number
  stderr: number
}

export function parseCursor(cursor: ProcessLogCursor | undefined): Offsets {
  const [out = '', err = ''] = (cursor ?? '').split(':')
  const stdout = Number.parseInt(out, 10)
  const stderr = Number.parseInt(err, 10)
  return {
    stdout: Number.isInteger(stdout) && stdout >= 0 ? stdout : 0,
    stderr: Number.isInteger(stderr) && stderr >= 0 ? stderr : 0,
  }
}

function formatCursor(offsets: Offsets): ProcessLogCursor {
  return `${offsets.stdout}:${offsets.stderr}`
}

/**
 * Build the `tail` argv for one stream.
 *
 * `-c +N` counts bytes rather than lines, so a process writing a partial line still has it
 * delivered, and the byte count is what the cursor is expressed in.
 */
function tailArgv(path: string, options: {
  fromByte: number
  follow: boolean
  wrapperPid?: number
}): string[] {
  const argv = ['tail', '-c', `+${options.fromByte + 1}`]
  // A follow needs a pid to end on. Without one `tail -f` never returns, so the read is taken
  // as a plain one to EOF: the process it would have followed is already gone, and a stream that
  // never closes is worse than one that stops at what was written.
  if (options.follow && options.wrapperPid !== undefined) {
    argv.push('-f', `--pid=${options.wrapperPid}`)
  }
  argv.push('--', path)
  return argv
}

interface StreamPump {
  kill: () => void
  done: Promise<void>
}

/** Read one `tail` exec, emitting an event per chunk and advancing that stream's offset. */
function pumpStream(options: {
  sandbox: MicroSandbox
  path: string
  type: 'stdout' | 'stderr'
  fromByte: number
  follow: boolean
  wrapperPid?: number
  offsets: Offsets
  emit: (event: ProcessLogEvent) => void
}): StreamPump {
  const { type, offsets, emit } = options
  // The exec is started asynchronously and the pump waits on it, so both streams are launched
  // together rather than one after the other — a serial start would let the first `tail` reach
  // EOF and exit before the second was even created.
  const started: Promise<GuestProcess> = spawnArgv(
    options.sandbox,
    tailArgv(options.path, {
      fromByte: options.fromByte,
      follow: options.follow,
      ...(options.wrapperPid === undefined ? {} : { wrapperPid: options.wrapperPid }),
    }),
  )

  const done = (async () => {
    const proc = await started
    for await (const chunk of proc.stdout) {
      if (chunk.byteLength === 0) {
        continue
      }
      offsets[type] += chunk.byteLength
      emit({ type, cursor: formatCursor(offsets), timestamp: new Date().toISOString(), data: chunk })
    }
  })()

  return {
    kill: () => void started.then(proc => proc.kill()).catch(() => undefined),
    done,
  }
}

export interface LogStreamOptions extends ProcessLogsOptions {
  sandbox: MicroSandbox
  paths: JournalPaths
  /** The wrapper pid, when it is known — a follow without one cannot self-terminate. */
  wrapperPid?: number
  /** Current byte sizes, used as the starting point when the caller did not ask for a replay. */
  liveOffsets: Offsets
  /** Emitted once both streams end, when the process's outcome is known. */
  terminal: (cursor: ProcessLogCursor) => Promise<ProcessLogEvent | undefined>
}

/**
 * Open the log as a stream of contract events.
 *
 * `replay` reads from the beginning of the retained files; without it the read starts at the live
 * tail. An explicit `since` wins over both, because a caller resuming from a cursor is saying
 * exactly where it stopped.
 */
export function openLogStream(options: LogStreamOptions): ReadableStream<ProcessLogEvent> {
  const follow = options.follow ?? false
  const offsets = options.since !== undefined
    ? parseCursor(options.since)
    : (options.replay === true ? { stdout: 0, stderr: 0 } : { ...options.liveOffsets })
  const start = { ...offsets }

  let pumps: StreamPump[] = []

  return new ReadableStream<ProcessLogEvent>({
    start: (controller) => {
      const emit = (event: ProcessLogEvent) => controller.enqueue(event)
      const shared = {
        sandbox: options.sandbox,
        follow,
        offsets,
        emit,
        ...(options.wrapperPid === undefined ? {} : { wrapperPid: options.wrapperPid }),
      }

      pumps = [
        pumpStream({ ...shared, path: options.paths.stdout, type: 'stdout', fromByte: start.stdout }),
        pumpStream({ ...shared, path: options.paths.stderr, type: 'stderr', fromByte: start.stderr }),
      ]

      const abort = () => {
        for (const pump of pumps) {
          pump.kill()
        }
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      // A signal that was already aborted never fires its listener, and both `tail` execs would
      // then run until the journalled process ended on its own.
      if (options.signal?.aborted === true) {
        abort()
      }

      void Promise.all(pumps.map(pump => pump.done))
        .then(async () => {
          if (options.signal?.aborted !== true) {
            const terminal = await options.terminal(formatCursor(offsets))
            if (terminal !== undefined) {
              controller.enqueue(terminal)
            }
          }
          controller.close()
        })
        .catch((cause: unknown) => controller.error(cause))
        .finally(() => options.signal?.removeEventListener('abort', abort))
    },
    cancel: () => {
      for (const pump of pumps) {
        pump.kill()
      }
    },
  })
}
