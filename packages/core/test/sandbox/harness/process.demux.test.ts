/*
 * Vendored from `chatbot-pf/pleaseworks` (`packages/harness-sandbox/src/process.demux.test.ts`), relicensed from
 * FSL-1.1-MIT to Apache-2.0 by the copyright holder, Passion Factory, Inc.
 *
 * Comments below naming paths such as `apps/cf-orchestrator/…`, `run/run-workflow.ts` or
 * sibling packages refer to that originating codebase, not to this repository. They are kept
 * because they record why each obligation exists.
 */
/**
 * What the demux does with a sink nobody is reading — the one place it can grow without bound.
 *
 * Its own file rather than a fourth block in `process.test.ts`, which is at the 500-line
 * ceiling, and a separate question in any case: every test there is about *routing*, and reads
 * its answer off a handful of short strings. These are about capacity, so each one has to push
 * a cap's worth of bytes through the split, and the assertions are byte counts rather than
 * text. Megabyte payloads also make the interleaving matter, which the short fixtures cannot
 * show (cubic review, PR #7).
 */
import type { ProcessLogEvent } from '../../../src/sandbox/contract'
import { describe, expect, it } from 'bun:test'
import { splitProcessStreams } from '../../../src/sandbox/harness/demux'

/** Big enough that a handful of chunks crosses the 8 MiB cap without allocating much. */
const CHUNK = 1024 * 1024

/**
 * A source shape that puts more than the 8 MiB cap through each stream, unevenly.
 *
 * Two `stdout` events per `stderr` event, twelve times over: 24 MiB of `stdout` and 12 MiB of
 * `stderr`, each comfortably past the cap, and neither aligned with the other's pulls.
 */
const PATTERN = ['stdout', 'stdout', 'stderr'] as const
const ROUNDS = 12

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

/** Total bytes a stream yields, without holding the whole payload as one string. */
async function byteCount(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return total
    }
    total += value.length
  }
}

describe('splitProcessStreams under a neglected sink', () => {
  /**
   * The cap must not fire under normal use, and this is what "normal use" means: `run` drains
   * both streams through one `Promise.all`, so neither sink ever holds more than the chunk the
   * other pull routed to it. Twelve MiB per stream is comfortably past the cap and none of it
   * is ever buffered.
   */
  it('delivers everything to a consumer reading both streams concurrently', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))

    expect(await Promise.all([byteCount(stdout), byteCount(stderr)])).toEqual([
      chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK,
      chunksOf(PATTERN, ROUNDS, 'stderr') * CHUNK,
    ])
  })

  /**
   * And the case the cap exists for. Reading `stdout` to completion routes every `stderr` event
   * into a sink nobody is pulling, which before the cap grew until the worker died.
   *
   * Both halves are asserted, because the guard is only worth having if it is surgical: the
   * stream being read still completes with every byte, and the failure lands on the stream that
   * was neglected, carrying a message that says what to do about it.
   */
  it('errors only the neglected stream, and only after the cap', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))

    expect(await byteCount(stdout)).toBe(chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK)
    // The whole message, not a fragment: it names the stream that failed, why it failed, and
    // the two things the caller can do instead. A guard whose error said only "buffer full"
    // would send the reader looking for a bug in the sandbox.
    await expect(byteCount(stderr)).rejects.toThrow(
      /sandbox stderr buffered more than \d+ bytes because it was not being read while the other stream was drained; read stdout and stderr concurrently, or cancel\(\) the one you do not need/,
    )
  })

  /**
   * A stream the consumer explicitly gave up on was already dropped from `sinks`, so nothing is
   * ever enqueued to it and it cannot overflow. Cancelling is the documented way to say "I am
   * not reading this", and it must not be turned into an error by the guard that punishes a
   * consumer for never saying so.
   */
  it('never errors a stream the consumer cancelled, however much flows past', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream(PATTERN, ROUNDS))
    await stderr.cancel()

    expect(await byteCount(stdout)).toBe(chunksOf(PATTERN, ROUNDS, 'stdout') * CHUNK)
  })

  /**
   * The exemption for the stream being pulled, stated as a test: a single chunk larger than the
   * cap is still delivered to the consumer asking for it. Capping the pulled sink too would
   * fail a read for a caller doing everything right.
   */
  it('delivers a single chunk larger than the cap to the stream being read', async () => {
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
