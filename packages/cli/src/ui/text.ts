/**
 * How wide a string is on screen, and how to cut it without breaking anything.
 *
 * `String.length` is the wrong measure three times over for the text this CLI prints: a
 * Korean or CJK glyph occupies two terminal cells, an emoji sequence is many code points but
 * one glyph in two cells, and an ANSI escape occupies none at all. A progress row fitted with
 * `.length` therefore wraps — and a wrapped row breaks the live region, whose repaint assumes
 * one row is one screen line.
 *
 * Measurement is per grapheme cluster via `Intl.Segmenter`, which the runtime already ships;
 * a cluster's width is the widest code point in it, so combining marks and zero-width joiners
 * cost nothing on top of the base character they attach to.
 *
 * Derived from vercel/eve `packages/eve/src/cli/ui/terminal-text.ts` (Apache-2.0) — see
 * NOTICE. The port drops eve's hand-written zero-width code point table in favour of Unicode
 * property escapes, and keeps only the measuring and clipping the boot chrome uses.
 */

import { ESC } from './ansi'

const RESET = `${ESC}[0m`
const ANSI_BODY = '\\[[0-?]*[ -/]*[@-~]'
const ANSI_PATTERN = new RegExp(ESC + ANSI_BODY, 'g')
const ANSI_PREFIX_PATTERN = new RegExp(`^${ESC}${ANSI_BODY}`)
/** Nonspacing and enclosing marks plus format characters (ZWJ, variation selectors). */
const ZERO_WIDTH_PATTERN = /^[\p{Mn}\p{Me}\p{Cf}]$/u
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u
const KEYCAP_PATTERN = /^[#*0-9]\u{FE0F}?\u{20E3}$/u
const VARIATION_SELECTOR_16 = '\u{FE0F}'

/** Cells a tab is rendered as. Fixed rather than stop-relative: a row has no column origin. */
const TAB_WIDTH = 4

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** East Asian Wide and Fullwidth ranges. No `\p{East_Asian_Width}` exists in JS regex. */
function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115F
    || codePoint === 0x2329 || codePoint === 0x232A
    || (codePoint >= 0x2E80 && codePoint <= 0xA4CF && codePoint !== 0x303F)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
    || (codePoint >= 0x1F300 && codePoint <= 0x1F64F)
    || (codePoint >= 0x1F900 && codePoint <= 0x1F9FF)
    || (codePoint >= 0x20000 && codePoint <= 0x3FFFD)
  )
}

function codePointWidth(character: string, codePoint: number): number {
  if (codePoint === 0x09) {
    return TAB_WIDTH
  }
  if (codePoint < 0x20 || (codePoint >= 0x7F && codePoint < 0xA0)) {
    return 0
  }
  if (ZERO_WIDTH_PATTERN.test(character)) {
    return 0
  }
  return isWideCodePoint(codePoint) ? 2 : 1
}

/**
 * Cells one grapheme cluster occupies.
 *
 * A cluster with emoji presentation is at least two cells even when its base code point is
 * narrow — a keycap digit and a heart carrying `U+FE0F` both render as wide glyphs.
 */
function graphemeWidth(grapheme: string): number {
  let width = 0
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined) {
      width = Math.max(width, codePointWidth(character, codePoint))
    }
  }

  const emojiPresentation = EMOJI_PRESENTATION_PATTERN.test(grapheme)
    || KEYCAP_PATTERN.test(grapheme)
    || (grapheme.includes(VARIATION_SELECTOR_16) && EXTENDED_PICTOGRAPHIC_PATTERN.test(grapheme))

  return emojiPresentation ? Math.max(2, width) : width
}

interface TextUnit {
  readonly text: string
  readonly width: number
  readonly ansi: boolean
}

/** Split into indivisible units: whole escape sequences (width 0) and grapheme clusters. */
function textUnits(input: string): TextUnit[] {
  const units: TextUnit[] = []
  let index = 0

  while (index < input.length) {
    const remaining = input.slice(index)
    const ansi = ANSI_PREFIX_PATTERN.exec(remaining)
    if (ansi !== null) {
      units.push({ text: ansi[0], width: 0, ansi: true })
      index += ansi[0].length
      continue
    }

    // `search` runs the pattern from 0 and restores `lastIndex`, so the `g` flag is inert here.
    const nextAnsi = remaining.search(ANSI_PATTERN)
    const plain = remaining.slice(0, nextAnsi === -1 ? remaining.length : nextAnsi)
    for (const { segment } of segmenter.segment(plain)) {
      units.push({ text: segment, width: graphemeWidth(segment), ansi: false })
    }
    index += plain.length
  }

  return units
}

/** Terminal cells the string occupies, ignoring styling. */
export function visibleLength(input: string): number {
  let width = 0
  for (const unit of textUnits(input)) {
    width += unit.width
  }
  return width
}

/**
 * The leading substring that fits in `width` cells.
 *
 * A wide grapheme that would straddle the limit is dropped whole rather than half-printed,
 * and any styling that follows the cut is carried along so a truncated string does not end
 * mid-escape.
 */
export function sliceVisible(input: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  const units = textUnits(input)
  let output = ''
  let visible = 0
  let index = 0

  while (index < units.length && visible < width) {
    const unit = units[index]!
    if (unit.width > 0 && visible + unit.width > width) {
      break
    }
    output += unit.text
    visible += unit.width
    index += 1
  }

  while (units[index]?.ansi === true) {
    output += units[index]!.text
    index += 1
  }

  return output
}

/** Clip to `width` cells, resetting styling if the cut left a sequence open. */
export function clipVisible(input: string, width: number): string {
  if (visibleLength(input) <= width) {
    return input
  }
  const sliced = sliceVisible(input, width)
  return sliced.includes(ESC) ? `${sliced}${RESET}` : sliced
}

/** Clip to `width` cells, marking the cut with an ellipsis when one was made. */
export function ellipsize(input: string, width: number): string {
  if (width <= 0) {
    return ''
  }
  if (visibleLength(input) <= width) {
    return input
  }
  if (width === 1) {
    return '…'
  }
  return `${clipVisible(input, width - 1)}…`
}
