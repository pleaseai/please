/**
 * The boot row: one animated line saying what the run is waiting on.
 *
 * `please dev` spends its first stretch doing nothing the user can see — pulling an image,
 * creating a container, letting the harness adapter install its runtime inside it. That is
 * tens of seconds during which a silent terminal is indistinguishable from a hang, so the row
 * names the phase and pulses to show the process is alive.
 *
 * Phases that finish are committed to scrollback, where they stay; the row itself is erased on
 * {@link BootRow.stop} so the interactive UI starts against a clean line.
 *
 * Two things are deliberately not animated: a non-TTY (a CI log, a pipe) gets one plain line
 * per phase instead, and so does any run whose output is being captured, because a repaint
 * written into a file is just escape noise.
 *
 * Derived from vercel/eve `packages/eve/src/cli/ui/live-row.ts` (Apache-2.0) — see NOTICE.
 */

import type { CliTheme } from './theme'
import process from 'node:process'
import { LiveRegion } from './live-region'
import {
  assertPulseSequence,
  PROGRESS_PULSE_ASCII_GLYPH,
  PROGRESS_PULSE_GLYPH,
  PROGRESS_PULSE_SEQUENCE,
  pulseStepDurationMs,
} from './progress-pulse'
import { sanitizeForTerminal } from './sanitize'
import { ellipsize, visibleLength } from './text'
import { createCliTheme } from './theme'

const DEFAULT_COLUMNS = 80

export interface BootRow {
  /** Replace the row. `detail` is the changing part — a container id, a pull percentage. */
  update: (message: string, detail?: string) => void
  /** Commit a finished phase to scrollback above the row, where it stays. */
  commit: (line: string) => void
  /** Stop animating and erase the row. Committed lines are untouched. Idempotent. */
  stop: () => void
}

export interface BootRowOutput {
  readonly columns?: number
  readonly isTTY?: boolean
  write: (chunk: string) => unknown
}

export interface BootRowOptions {
  readonly output?: BootRowOutput
  readonly theme?: CliTheme
  /** Force animation on or off. Defaults to whether the output is a TTY. */
  readonly animate?: boolean
  /** Force the ASCII glyph. Defaults to whether the environment claims a UTF-8 locale. */
  readonly ascii?: boolean
  readonly pulseSequence?: string
}

/** Collapse whitespace so a multi-line detail cannot turn one row into several. */
function toRowText(input: string): string {
  return sanitizeForTerminal(input).replace(/\s+/g, ' ').trim()
}

function supportsUnicode(): boolean {
  if (process.env.TERM === 'dumb') {
    return false
  }
  const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? ''
  return /UTF-?8/i.test(locale)
}

/**
 * Lay out `glyph message detail` in one line.
 *
 * The detail is fitted to whatever the message leaves, and dropped to an ellipsis rather than
 * allowed to wrap. One column is held back: a row filling the last cell leaves some terminals
 * in a pending-wrap state whose interaction with the next repaint differs between them.
 */
function renderBootRow(input: {
  readonly theme: CliTheme
  readonly glyph: string
  readonly lit: boolean
  readonly message: string
  readonly detail: string
  readonly columns: number | undefined
}): string {
  const maxWidth = Math.max(0, (input.columns ?? DEFAULT_COLUMNS) - 1)
  const head = `${input.message}${input.detail === '' ? '...' : ''}`
  const glyph = input.lit ? input.theme.success(input.glyph) : ' '
  const headWidth = visibleLength(input.glyph) + 1 + visibleLength(head)

  if (headWidth >= maxWidth) {
    return ellipsize(`${glyph} ${head}`, maxWidth)
  }
  if (input.detail === '') {
    return `${glyph} ${head}`
  }

  const detail = ellipsize(` ${input.detail}`, maxWidth - headWidth)
  return `${glyph} ${head}${input.theme.muted(detail)}`
}

/** Start the boot row. Always returns a handle, animating or not. */
export function startBootRow(options: BootRowOptions = {}): BootRow {
  const output = options.output ?? process.stdout
  const theme = options.theme ?? createCliTheme()
  const pulseSequence = options.pulseSequence ?? PROGRESS_PULSE_SEQUENCE
  assertPulseSequence(pulseSequence)

  const animate = options.animate ?? output.isTTY === true
  const glyph = (options.ascii ?? !supportsUnicode())
    ? PROGRESS_PULSE_ASCII_GLYPH
    : PROGRESS_PULSE_GLYPH
  const live = animate ? new LiveRegion(output) : undefined

  let stepIndex = 0
  let lit = pulseSequence[0] === '1'
  let current: { message: string, detail: string } | undefined
  let loggedMessage: string | undefined
  let painted = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const paint = (): void => {
    if (current === undefined || live === undefined) {
      return
    }
    live.update([renderBootRow({ theme, glyph, lit, ...current, columns: output.columns })])
    painted = true
  }

  // Re-armed per step rather than driven by one interval: the steps have unequal durations,
  // and an unref'd timer must never be the reason the process stays alive.
  const scheduleStep = (): void => {
    timer = setTimeout(() => {
      if (stopped) {
        return
      }
      stepIndex = (stepIndex + 1) % pulseSequence.length
      const nextLit = pulseSequence[stepIndex] === '1'
      if (nextLit !== lit) {
        lit = nextLit
        paint()
      }
      scheduleStep()
    }, pulseStepDurationMs(stepIndex, pulseSequence.length))
    timer.unref?.()
  }

  return {
    update(message, detail = '') {
      if (stopped) {
        return
      }
      current = { message: toRowText(message), detail: toRowText(detail) }

      if (!animate) {
        // Detail-only changes are dropped: without a repaint they would be one log line each.
        if (current.message !== loggedMessage) {
          loggedMessage = current.message
          output.write(`${current.message}...\n`)
        }
        return
      }

      paint()
      if (timer === undefined) {
        scheduleStep()
      }
    },
    commit(line) {
      if (stopped) {
        return
      }
      const committed = toRowText(line)
      if (live === undefined || current === undefined) {
        output.write(`${committed}\n`)
        return
      }
      live.flush(
        [committed],
        [renderBootRow({ theme, glyph, lit, ...current, columns: output.columns })],
      )
      painted = true
    },
    stop() {
      if (stopped) {
        return
      }
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (live !== undefined && painted) {
        live.clear()
      }
    },
  }
}
