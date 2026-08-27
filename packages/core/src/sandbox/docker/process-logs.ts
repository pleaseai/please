/**
 * A process's log, read back out of its journal files.
 *
 * Both streams are followed with `tail --pid=<wrapper>`, which is what ends the read when the
 * process ends: the wrapper writes its exit line and dies, `tail` flushes what is left and
 * exits on its own. Polling for the exit file instead would either truncate the tail of the
 * output or keep the reader alive after the process was gone.
 *
 * A cursor is `<stdout-bytes>:<stderr-bytes>` — how much of each file the caller has already
 * seen. It is opaque by contract, and this is the shape it happens to take.
 */
import type { ProcessLogCursor, ProcessLogEvent, ProcessLogsOptions } from '../contract'
import type { JournalPaths } from './journal'
import { spawnInContainer } from './exec'

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
  if (options.follow) {
    argv.push('-f')
    // Without this the reader outlives the process it is reading. With it, `tail` performs a
    // final read after the pid is gone, so nothing written just before the exit is lost.
    if (options.wrapperPid !== undefined) {
      argv.push(`--pid=${options.wrapperPid}`)
    }
  }
  argv.push(path)
  return argv
}

interface StreamPump {
  kill: () => void
  done: Promise<void>
}

/** Read one `tail` process, emitting an event per chunk and advancing that stream's offset. */
function pumpStream(options: {
  container: string
  path: string
  type: 'stdout' | 'stderr'
  fromByte: number
  follow: boolean
  wrapperPid?: number
  offsets: Offsets
  emit: (event: ProcessLogEvent) => void
}): StreamPump {
  const { type, offsets, emit } = options
  const proc = spawnInContainer(
    options.container,
    tailArgv(options.path, {
      fromByte: options.fromByte,
      follow: options.follow,
      ...(options.wrapperPid === undefined ? {} : { wrapperPid: options.wrapperPid }),
    }),
  )

  const done = (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      if (chunk.byteLength === 0) {
        continue
      }
      offsets[type] += chunk.byteLength
      emit({ type, cursor: formatCursor(offsets), timestamp: new Date().toISOString(), data: chunk })
    }
    await proc.exited
  })()

  return { kill: () => proc.kill(), done }
}

export interface LogStreamOptions extends ProcessLogsOptions {
  container: string
  paths: JournalPaths
  /** The wrapper pid, when it is known — a follow without one cannot self-terminate. */
  wrapperPid?: number
  /** Current byte sizes, used as the starting point when the caller did not ask for a replay. */
  liveOffsets: Offsets
  /** Emitted once both streams end, when the process's outcome is known. */
  terminal: () => Promise<ProcessLogEvent | undefined>
}

/**
 * Open the log as a stream of contract events.
 *
 * `replay` reads from the beginning of the retained files; without it the read starts at the
 * live tail. An explicit `since` wins over both, because a caller resuming from a cursor is
 * saying exactly where it stopped.
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
        container: options.container,
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

      void Promise.all(pumps.map(pump => pump.done))
        .then(async () => {
          if (options.signal?.aborted !== true) {
            const terminal = await options.terminal()
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
