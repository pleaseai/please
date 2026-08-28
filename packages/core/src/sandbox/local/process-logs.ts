/**
 * A process's log, read back out of its journal files.
 *
 * The Docker backend follows both streams with `tail -f --pid=<wrapper>`, which ends the read
 * exactly when the process does. Neither half of that is available here: `--pid` is a GNU
 * extension and BSD `tail` has no equivalent, and shelling out to follow a file the host can
 * simply read would be a round trip bought for nothing. So a follow is a poll — the file's
 * size is compared against the offset already delivered, and the stream ends one drain *after*
 * the wrapper stops, so whatever the command wrote on its way out is delivered rather than cut.
 *
 * A cursor is `<stdout-bytes>:<stderr-bytes>` — how much of each file the caller has already
 * seen. It is opaque by contract, and this is the shape it happens to take.
 */
import type { ProcessLogCursor, ProcessLogEvent, ProcessLogsOptions } from '../contract'
import type { JournalPaths } from './journal'
import { stat } from 'node:fs/promises'

/** How often a follow re-reads the two files. */
const POLL_INTERVAL_MS = 50

/**
 * Most bytes carried by one event.
 *
 * A replay of a long-running turn's output would otherwise arrive as a single event holding
 * the whole file, which defeats every caller that is streaming precisely so it does not have
 * to hold one.
 */
const MAX_CHUNK_BYTES = 64 * 1024

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

/** A journal file's current size, or 0 while it does not exist yet. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  }
  catch {
    return 0
  }
}

/** Both files' sizes, for a read that starts at the live tail rather than the beginning. */
export async function readLiveOffsets(paths: JournalPaths): Promise<Offsets> {
  const [stdout, stderr] = await Promise.all([fileSize(paths.stdout), fileSize(paths.stderr)])
  return { stdout, stderr }
}

export interface LogStreamOptions extends ProcessLogsOptions {
  paths: JournalPaths
  /** Current byte sizes, used as the starting point when the caller did not ask for a replay. */
  liveOffsets: Offsets
  /** Whether the wrapper is still writing. A follow ends one drain after this turns false. */
  isRunning: () => Promise<boolean>
  /** Emitted once the read ends, when the process's outcome is known. */
  terminal: (cursor: ProcessLogCursor) => Promise<ProcessLogEvent | undefined>
}

/**
 * Deliver everything one stream has written past its offset, in bounded chunks.
 *
 * Returns whether anything was delivered, which is what tells a follow that a file it thought
 * was finished is still moving.
 */
async function drainStream(options: {
  path: string
  type: 'stdout' | 'stderr'
  offsets: Offsets
  emit: (event: ProcessLogEvent) => void
  stopped: () => boolean
}): Promise<boolean> {
  const { type, offsets, emit } = options
  let delivered = false

  for (;;) {
    const size = await fileSize(options.path)
    const from = offsets[type]
    if (size <= from || options.stopped()) {
      return delivered
    }
    const to = Math.min(size, from + MAX_CHUNK_BYTES)
    const data = await Bun.file(options.path).slice(from, to).bytes()
    // A file that shrank under a truncating writer would produce a negative slice and a zero
    // read; treating that as "nothing more" is better than looping on it forever.
    if (data.byteLength === 0) {
      return delivered
    }
    offsets[type] = from + data.byteLength
    delivered = true
    emit({ type, cursor: formatCursor(offsets), timestamp: new Date().toISOString(), data })
  }
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

  let cancelled = false

  return new ReadableStream<ProcessLogEvent>({
    start: (controller) => {
      const emit = (event: ProcessLogEvent) => controller.enqueue(event)
      const stopped = () => cancelled || options.signal?.aborted === true

      const abort = () => {
        cancelled = true
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      // A signal that was already aborted never fires its listener, and the poll below would
      // then run to the end of the process it was told to stop watching.
      if (options.signal?.aborted === true) {
        abort()
      }

      const drain = async () => Promise.all([
        drainStream({ path: options.paths.stdout, type: 'stdout', offsets, emit, stopped }),
        drainStream({ path: options.paths.stderr, type: 'stderr', offsets, emit, stopped }),
      ]).then(([out, err]) => out || err)

      const pump = async () => {
        await drain()
        if (!follow) {
          return
        }
        while (!stopped()) {
          // Read liveness *before* the drain that follows it. The other order loses whatever
          // the command wrote between a drain and the check that found it gone.
          const running = await options.isRunning()
          const grew = await drain()
          if (!running && !grew) {
            return
          }
          if (!stopped()) {
            await Bun.sleep(POLL_INTERVAL_MS)
          }
        }
      }

      void pump()
        .then(async () => {
          if (!stopped()) {
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
      cancelled = true
    },
  })
}
