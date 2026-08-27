/*
 * Vendored from `chatbot-pf/pleaseworks` (`packages/harness-sandbox/src/process.demux.test.ts`), relicensed from
 * FSL-1.1-MIT to Apache-2.0 by the copyright holder, Passion Factory, Inc.
 *
 * Comments below naming paths such as `apps/cf-orchestrator/…`, `run/run-workflow.ts` or
 * sibling packages refer to that originating codebase, not to this repository. They are kept
 * because they record why each obligation exists.
 */
/**
 * The demux at volume — tens of megabytes, uneven interleaving, and a lagging consumer.
 *
 * Its own file rather than a fourth block in `process.test.ts`, which is at the 500-line ceiling,
 * and a separate question in any case: every test there is about *routing* and reads its answer
 * off a handful of short strings. These push real payloads through, so the assertions are byte
 * counts, and the interleaving and the consumers' relative pace both matter.
 *
 * They exist because a per-sink byte cap was attempted here and withdrawn — see the hazard note
 * at the top of `demux.ts`. These are the cases that measured it failing working callers, kept as
 * regression cover for the property that survived: whatever the volume, the interleaving or the
 * consumers' pace, both streams deliver every byte and neither is ever failed (cubic review,
 * PR #7).
 */
import type { ProcessLogEvent } from '../../../src/sandbox/contract'
import { describe, expect, it } from 'bun:test'
import { splitProcessStreams } from '../../../src/sandbox/harness/demux'

/** Big enough that a handful of chunks crosses the 8 MiB cap without allocating much. */
const CHUNK = 1024 * 1024

/**
 * An uneven source shape: two `stdout` events per `stderr` event, forty times over.
 *
 * 80 MiB of `stdout` against 40 MiB of `stderr`, and — the part that matters — not aligned with
 * either consumer's pulls, so each stream's drain routes the other's chunks rather than every
 * event arriving during its own stream's pull. An alternating pattern exercises none of that.
 */
const PATTERN = ['stdout', 'stdout', 'stderr'] as const
const ROUNDS = 40

/**
 * `pattern` repeated `rounds` times, one megabyte chunk per event, allocated as it is pulled.
 *
 * Lazily rather than from a prebuilt array so a test pushing tens of megabytes through holds
 * only the chunks still in flight.
 *
 * The pattern is the parameter that matters, and an *uneven* one is what makes these tests bite.
 * Under a strict `stdout, stderr, stdout, stderr` source with two concurrent consumers, every
 * event arrives during its own stream's pull, so the routing of the other source's events —
 * the thing the cap is about — never happens at all. A pattern that emits two of one stream per
 * one of the other forces it: the second `stdout` chunk of each round is read by `stderr`'s pull
 * and routed across, which is the path both the cap and its reset live on (measured: the aligned
 * pattern leaves the reset unpinned, this one fails without it).
 */
function eventStream(
  pattern: readonly ('stdout' | 'stderr')[],
  rounds: number,
): ReadableStream<ProcessLogEvent> {
  let emitted = 0
  const total = pattern.length * rounds
  return new ReadableStream<ProcessLogEvent>({
    pull: (controller) => {
      if (emitted >= total) {
        controller.close()
        return
      }
      const type = pattern[emitted++ % pattern.length]
      controller.enqueue({ type, data: new Uint8Array(CHUNK) } as ProcessLogEvent)
    },
  })
}

/** How many chunks of `source` a `pattern` × `rounds` stream carries. */
function chunksOf(pattern: readonly ('stdout' | 'stderr')[], rounds: number, source: string): number {
  return pattern.filter(entry => entry === source).length * rounds
}

/**
 * Total bytes a stream yields, optionally reading at a deliberately slow cadence.
 *
 * `lagPerRead` awaits a macrotask after every chunk, which models any consumer doing real work
 * or I/O per chunk. It is not a cosmetic delay: microtasks starve macrotasks completely, so a
 * lagging consumer gets no turn at all while the other stream's drain runs, and its queue grows
 * to the whole payload. That is the case a byte cap could not survive.
 */
async function byteCount(stream: ReadableStream<Uint8Array>, lagPerRead = false): Promise<number> {
  const reader = stream.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return total
    }
    total += value.length
    if (lagPerRead) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
}

describe('splitProcessStreams at volume', () => {
  /** What `run` does: both streams drained through one `Promise.all`, 120 MiB between them. */
  it('delivers everything to a consumer reading both streams concurrently', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))

    expect(await Promise.all([byteCount(stdout), byteCount(stderr)])).toEqual([
      chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK,
      chunksOf(PATTERN, ROUNDS, 'stderr') * CHUNK,
    ])
  })

  /**
   * The case that withdrew the cap, kept as the regression test for it.
   *
   * `stderr` is read to completion, just one macrotask slower per chunk than `stdout` — and
   * because microtasks starve macrotasks, it takes nothing at all while `stdout`'s drain routes
   * the entire 40 MiB into its queue. Every byte must still arrive. A guard that bounded this
   * sink by occupancy, or by whether its consumer had read anything recently, failed it.
   */
  it('delivers everything to a consumer reading one stream a macrotask slower', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))

    expect(await Promise.all([byteCount(stdout), byteCount(stderr, true)])).toEqual([
      chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK,
      chunksOf(PATTERN, ROUNDS, 'stderr') * CHUNK,
    ])
  })

  /**
   * And the other order, because the two streams are not symmetrical in construction: `stdout`'s
   * controller is created first and pulls first.
   */
  it('delivers everything when it is the first stream that lags', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))

    expect(await Promise.all([byteCount(stdout, true), byteCount(stderr)])).toEqual([
      chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK,
      chunksOf(PATTERN, ROUNDS, 'stderr') * CHUNK,
    ])
  })

  /**
   * Cancelling is the documented way to say "I am not reading this": the sink is dropped and its
   * events are discarded, while the drain keeps running at full speed for the other stream.
   */
  it('serves the other stream at full volume after one is cancelled', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))
    await stderr.cancel()

    expect(await byteCount(stdout)).toBe(chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK)
  })

  /** One very large chunk, since nothing here may assume a payload arrives in small pieces. */
  it('delivers a single chunk far larger than any one round', async () => {
    const oversized = new Uint8Array(chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK)
    const { stdout } = splitProcessStreams(new ReadableStream<ProcessLogEvent>({
      start: (controller) => {
        controller.enqueue({ type: 'stdout', data: oversized } as ProcessLogEvent)
        controller.close()
      },
    }))

    expect(await byteCount(stdout)).toBe(oversized.length)
  })
})
