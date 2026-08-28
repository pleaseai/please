/**
 * The pulse's arithmetic.
 *
 * The property worth pinning is that the rounding does not drift: a loop whose steps summed to
 * 999 or 1001 ms would slowly fall out of step with anything else timed against the same
 * duration, and the drift is exactly the kind that never shows up in a short test run.
 */
import { describe, expect, it } from 'bun:test'
import {
  assertPulseSequence,
  InvalidPulseSequenceError,
  isProgressPulseVisible,
  PROGRESS_PULSE_DURATION_MS,
  PROGRESS_PULSE_SEQUENCE,
  pulseStepDurationMs,
} from '../../src/ui/progress-pulse'

describe('assertPulseSequence', () => {
  it('accepts the sequence the boot row uses', () => {
    expect(() => assertPulseSequence(PROGRESS_PULSE_SEQUENCE)).not.toThrow()
  })

  it('accepts an eight-step sequence', () => {
    expect(() => assertPulseSequence('11110000')).not.toThrow()
  })

  it('rejects a length that would animate at an unintended rate', () => {
    expect(() => assertPulseSequence('1010')).toThrow(InvalidPulseSequenceError)
  })

  it('rejects a step that is neither lit nor unlit', () => {
    expect(() => assertPulseSequence('1111000x')).toThrow(InvalidPulseSequenceError)
  })
})

describe('pulseStepDurationMs', () => {
  it('sums to exactly one loop, so the rounding cannot accumulate', () => {
    for (const stepCount of [8, 16]) {
      const total = Array.from(
        { length: stepCount },
        (_, index) => pulseStepDurationMs(index, stepCount),
      ).reduce((sum, step) => sum + step, 0)

      expect(total).toBe(PROGRESS_PULSE_DURATION_MS)
    }
  })
})

describe('isProgressPulseVisible', () => {
  it('reads the step the elapsed time falls in', () => {
    expect(isProgressPulseVisible(0, '11110000')).toBe(true)
    expect(isProgressPulseVisible(PROGRESS_PULSE_DURATION_MS / 2, '11110000')).toBe(false)
  })

  it('repeats every loop', () => {
    const elapsed = 250
    expect(isProgressPulseVisible(elapsed + PROGRESS_PULSE_DURATION_MS * 3))
      .toBe(isProgressPulseVisible(elapsed))
  })
})
