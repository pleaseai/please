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
 * How many bytes one sink may hold for a consumer that is not reading it.
 *
 * The number is deliberately generous, because the payload here is a coding agent's own build
 * and test output and this only ever fires on a sink nobody is pulling: a consumer reading both
 * streams never accumulates anything (see {@link routeChunk}), so 8 MiB is not a budget anyone
 * spends, it is the distance between "slow consumer" and "consumer that is never coming back".
 * A 32-bit `Uint8Array` of that size is ~0.8% of a default 1 GiB workerd heap, so the guard
 * trips well before the worker is in trouble and well after any plausible burst.
 */
const SINK_BUFFER_LIMIT = 8 * 1024 * 1024

interface DemuxState {
  reader: ReadableStreamDefaultReader<ProcessLogEvent>
  sinks: Record<StreamSource, ReadableStreamDefaultController<Uint8Array> | undefined>
  /**
   * Bytes enqueued to each sink and not yet taken by its consumer.
   *
   * Counted here rather than read off `ReadableStreamDefaultController.desiredSize`, and the
   * reason is what `desiredSize` measures: it is `highWaterMark - queueTotalSize`, and both are
   * in *chunks* unless the stream is built with a byte-counting `size()` strategy. Giving these
   * streams one would answer the byte question — the runtime maintains `queueTotalSize` exactly,
   * incrementing on enqueue and decrementing as the consumer reads — but it would also raise the
   * high-water mark from one chunk to the cap, and `pull` is called for as long as `desiredSize`
   * stays positive. The demux would stop being demand-driven and start prefetching a cap's worth
   * of output per stream, which is a different streaming contract than the one every test here
   * pins. So the mark stays at its default and the bytes are counted directly.
   */
  buffered: Record<StreamSource, number>
  /** Sources whose consumer cancelled, or whose buffer overflowed. Both stop being enqueued to. */
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
 * Hand one event's bytes to its sink, or drop a sink that has stopped taking them.
 *
 * The routing {@link drainUntil} does for the *other* stream is what makes the demux work and
 * is also the only place it can grow without bound: those bytes are enqueued as a side effect
 * of serving the stream being pulled, so nothing about the other consumer's demand is consulted
 * — and a consumer that reads one stream while ignoring the other therefore accumulates the
 * whole of the ignored one in memory. A sandbox log is exactly the payload that makes that
 * fatal, and the failure mode was the worker dying rather than anything the caller could see.
 *
 * The cap is on the *sink*, never on the drain. Stopping the drain to wait for the neglected
 * consumer is the one thing this design cannot do — it is precisely the hang the routing exists
 * to prevent, and it would be reintroduced for every consumer that reads a single stream. So an
 * over-cap sink is errored and then treated exactly like a cancelled one: struck from `sinks`,
 * added to `abandoned`, its events discarded from here on while the drain runs at full speed
 * for the other stream. Nothing can hang, and nothing that *is* being read is affected.
 *
 * `wanted` is exempt because it cannot overflow: `drainUntil` returns the moment it enqueues
 * for `wanted`, so that sink takes at most one chunk per pull, and `pull` is only ever called
 * on an empty queue. The exemption matters anyway — it is what guarantees a single chunk larger
 * than the cap still reaches the consumer asking for it.
 *
 * The message names the stream and the fix because nothing else in the caller's world explains
 * why a stream it never touched has failed (cubic review, PR #7).
 */
function routeChunk(state: DemuxState, source: StreamSource, data: Uint8Array, wanted: StreamSource): void {
  const sink = state.sinks[source]
  if (sink === undefined) {
    return
  }
  const buffered = state.buffered[source] + data.byteLength
  if (source !== wanted && buffered > SINK_BUFFER_LIMIT) {
    state.sinks[source] = undefined
    state.abandoned.add(source)
    state.buffered[source] = 0
    sink.error(new Error(
      `sandbox ${source} buffered more than ${SINK_BUFFER_LIMIT} bytes because it was not being `
      + `read while the other stream was drained; read stdout and stderr concurrently, or `
      + `cancel() the one you do not need`,
    ))
    return
  }
  state.buffered[source] = buffered
  sink.enqueue(data)
}

/**
 * Read the shared source until `wanted` sees a chunk, routing everything passed on the way.
 *
 * Draining only the source being pulled would hang a consumer that reads `stderr` to
 * completion before touching `stdout`: the events it needs would sit unread behind events
 * for the other stream. `terminal` and `truncated` events are dropped — the harness's
 * streams are bytes and have no representation for either, and the exit reaches the caller
 * through `wait()`. What that routing costs when the other consumer never arrives, and the
 * bound that keeps it survivable, are {@link routeChunk}'s subject.
 */
async function drainUntil(state: DemuxState, wanted: StreamSource): Promise<void> {
  // `pull` is called only while `desiredSize` is positive, and with the default queuing
  // strategy — one chunk of high-water mark, chunks counted by number — that is true only of an
  // empty queue. So being called at all is proof the consumer has taken everything previously
  // enqueued for `wanted`, and zero is the exact count rather than an approximation of one.
  state.buffered[wanted] = 0
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
    routeChunk(state, event.type, event.data, wanted)
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
 * releases the shared source. A sink that overflows {@link SINK_BUFFER_LIMIT} joins that same
 * path, errored rather than closed — the difference is only how the consumer finds out.
 */
export function splitProcessStreams(events: ReadableStream<ProcessLogEvent>): SplitProcessStreams {
  const state: DemuxState = {
    reader: events.getReader(),
    sinks: { stdout: undefined, stderr: undefined },
    buffered: { stdout: 0, stderr: 0 },
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
