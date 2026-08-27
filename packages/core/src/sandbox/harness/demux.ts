/*
 * Vendored from `chatbot-pf/pleaseworks` (`packages/harness-sandbox/src/process.ts`), relicensed from
 * FSL-1.1-MIT to Apache-2.0 by the copyright holder, Passion Factory, Inc.
 *
 * Comments below naming paths such as `apps/cf-orchestrator/…`, `run/run-workflow.ts` or
 * sibling packages refer to that originating codebase, not to this repository. They are kept
 * because they record why each obligation exists.
 */
/**
 * One tagged `ProcessLogEvent` stream into the two byte streams the harness expects.
 *
 * Split out of `process.ts` when the buffer bound below took that file past the 500-line limit,
 * along a seam that was already there: `process.ts` is `run`/`spawn` over the contract's
 * `exec`, and this is one reader feeding two consumers who read it at their own pace. They
 * share nothing but `ProcessLogEvent`, and `spawn` is the only caller of what is exported here.
 */
import type { ProcessLogEvent } from '../contract'

export interface SplitProcessStreams {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}

type StreamSource = 'stdout' | 'stderr'

/**
 * **Known hazard, deliberately not guarded: an unread sink buffers without bound.**
 *
 * {@link drainUntil} enqueues the *other* stream's bytes as a side effect of serving the stream
 * being pulled, consulting nothing about that other consumer's demand, so a caller that reads one
 * stream while ignoring the other accumulates the whole of the ignored one in memory — and a
 * sandbox log is exactly the payload that makes that fatal.
 *
 * A per-sink byte cap was built for this and then withdrawn, because every version of it failed a
 * consumer that was working correctly. What was measured (cubic review, PR #7):
 *
 * - There is no backpressure from a sink to the shared reader, and there cannot be: pausing the
 *   drain until the neglected consumer catches up is precisely the hang the routing exists to
 *   prevent, and a consumer that reads one stream to completion before touching the other would
 *   deadlock rather than merely run out of memory.
 * - So an *occupancy* cap fires on a live consumer that is simply slower than the other one. With
 *   a one-macrotask lag per read and 40 MiB through each stream, real occupancy reached 9 MiB and
 *   was still climbing — a stream being read to completion, errored.
 * - A *stall* variant — error only a sink whose consumer has taken nothing — fails for a deeper
 *   reason: the drain resolves on microtasks and a consumer on a macrotask cadence gets no turn
 *   at all while it runs (measured: 100 000 microtask turns before one `setTimeout(0)` fired), so
 *   "has taken nothing" cannot distinguish a slow consumer from an absent one.
 *
 * Bounding this needs something the contract does not currently offer — an obligation on callers
 * to read both streams or `cancel()` one, which would make pausing the drain legitimate, or a
 * spill destination that is not the heap. Until then the hazard is documented rather than traded
 * for a guard that breaks working callers.
 */

interface DemuxState {
  reader: ReadableStreamDefaultReader<ProcessLogEvent>
  sinks: Record<StreamSource, ReadableStreamDefaultController<Uint8Array> | undefined>
  /** Sources whose consumer cancelled. The reader is released once both have. */
  abandoned: Set<StreamSource>
  ended: boolean
}

/** Close both sinks, or error them, exactly once. */
function finishDemux(state: DemuxState, cause?: unknown): void {
  if (state.ended) {
    return
  }
  state.ended = true
  for (const sink of [state.sinks.stdout, state.sinks.stderr]) {
    if (cause === undefined) {
      sink?.close()
    }
    else {
      sink?.error(cause)
    }
  }
}

/**
 * Read the shared source until `wanted` sees a chunk, routing everything passed on the way.
 *
 * Draining only the source being pulled would hang a consumer that reads `stderr` to
 * completion before touching `stdout`: the events it needs would sit unread behind events
 * for the other stream. `terminal` and `truncated` events are dropped — the harness's
 * streams are bytes and have no representation for either, and the exit reaches the caller
 * through `wait()`. What that routing costs when the other consumer never arrives is the
 * hazard note at the top of this file.
 */
async function drainUntil(state: DemuxState, wanted: StreamSource): Promise<void> {
  for (;;) {
    if (state.ended) {
      return
    }
    let event: ProcessLogEvent
    try {
      const next = await state.reader.read()
      if (next.done) {
        finishDemux(state)
        return
      }
      event = next.value
    }
    catch (cause) {
      finishDemux(state, cause)
      throw cause
    }
    if (event.type !== 'stdout' && event.type !== 'stderr') {
      continue
    }
    state.sinks[event.type]?.enqueue(event.data)
    if (event.type === wanted) {
      return
    }
  }
}

/**
 * One tagged event stream into the two byte streams the harness expects.
 *
 * Both outputs read from a single reader, which is what {@link drainUntil} is shaped around.
 * A cancelled consumer drops its sink rather than releasing the reader, so the drain keeps
 * discarding that source's events for the other stream's benefit; only the second cancel
 * releases the shared source.
 */
export function splitProcessStreams(events: ReadableStream<ProcessLogEvent>): SplitProcessStreams {
  const state: DemuxState = {
    reader: events.getReader(),
    sinks: { stdout: undefined, stderr: undefined },
    abandoned: new Set(),
    ended: false,
  }

  const streamFor = (source: StreamSource): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        state.sinks[source] = controller
      },
      pull: () => drainUntil(state, source),
      cancel: async () => {
        state.abandoned.add(source)
        state.sinks[source] = undefined
        if (state.abandoned.size === 2) {
          await state.reader.cancel().catch(() => {})
        }
      },
    })

  return { stdout: streamFor('stdout'), stderr: streamFor('stderr') }
}
