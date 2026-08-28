/**
 * The one-cell indicator the boot row animates.
 *
 * A pulse rather than a spinner: the boot is not a sequence of quick steps whose motion says
 * something, it is a handful of long waits — pulling an image, installing the runtime inside
 * the container — where a fast spinner overstates how much is happening. The lit/unlit pattern
 * is asymmetric so the loop reads as a heartbeat rather than a blink.
 *
 * Derived from vercel/eve `packages/eve/src/cli/ui/progress-pulse.ts` (Apache-2.0) — see NOTICE.
 */

export const PROGRESS_PULSE_GLYPH = '▪'

/** Single-cell fallback for terminals without the block glyph. */
export const PROGRESS_PULSE_ASCII_GLYPH = '*'

/** Lit (`1`) and unlit (`0`) steps of one loop. Must be 8 or 16 steps long. */
export const PROGRESS_PULSE_SEQUENCE = '1111110000111111'

/** Wall-clock duration of one complete loop. */
export const PROGRESS_PULSE_DURATION_MS = 1000

export class InvalidPulseSequenceError extends RangeError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPulseSequenceError'
  }
}

/** Reject a sequence that would animate at an unintended rate or draw nothing. */
export function assertPulseSequence(sequence: string): void {
  if (sequence.length !== 8 && sequence.length !== 16) {
    throw new InvalidPulseSequenceError('A pulse sequence must contain 8 or 16 steps.')
  }
  if (/[^01]/.test(sequence)) {
    throw new InvalidPulseSequenceError('A pulse sequence step must be "0" or "1".')
  }
  // An all-unlit sequence type-checks and animates, but never draws the glyph — which is
  // the one thing the row exists to show. Silence there reads as a hang.
  if (!sequence.includes('1')) {
    throw new InvalidPulseSequenceError('A pulse sequence must have at least one lit step.')
  }
}

/**
 * Milliseconds step `index` is held for.
 *
 * Computed from the rounded boundaries either side of the step rather than by dividing the
 * duration, so the rounding error does not accumulate and a 16-step loop still takes exactly
 * {@link PROGRESS_PULSE_DURATION_MS}.
 */
export function pulseStepDurationMs(index: number, stepCount: number): number {
  const start = Math.round((index * PROGRESS_PULSE_DURATION_MS) / stepCount)
  const end = Math.round(((index + 1) * PROGRESS_PULSE_DURATION_MS) / stepCount)
  return end - start
}

/** Whether the pulse is lit at an elapsed time, for a caller driving its own clock. */
export function isProgressPulseVisible(
  elapsedMs: number,
  sequence: string = PROGRESS_PULSE_SEQUENCE,
): boolean {
  const loopTime = elapsedMs % PROGRESS_PULSE_DURATION_MS
  const step = Math.floor((loopTime * sequence.length) / PROGRESS_PULSE_DURATION_MS)
  return sequence[step] === '1'
}
