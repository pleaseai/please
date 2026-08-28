/**
 * What survives sanitization, and what does not.
 *
 * The cases that matter are the ones where dropping the escape character alone would leave
 * readable garbage behind — a colour code's `[31m`, a title-setting OSC's payload.
 *
 * Control characters are built with `String.fromCharCode` rather than written literally:
 * a raw control byte in a test file is invisible in every diff that would review it.
 */
import { describe, expect, it } from 'bun:test'
import { sanitizeForTerminal } from '../../src/ui/sanitize'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const C1_CSI = String.fromCharCode(0x9B)
const BACKSPACE = String.fromCharCode(8)

describe('sanitizeForTerminal', () => {
  it('removes a colour sequence whole, not just its escape character', () => {
    expect(sanitizeForTerminal(`${ESC}[31mred${ESC}[0m`)).toBe('red')
  })

  it('removes an OSC sequence and its payload, terminated by BEL', () => {
    expect(sanitizeForTerminal(`${ESC}]0;window title${BEL}text`)).toBe('text')
  })

  it('removes an OSC sequence terminated by ESC backslash', () => {
    expect(sanitizeForTerminal(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe('link')
  })

  it('consumes the argument of a charset designation', () => {
    expect(sanitizeForTerminal(`${ESC}(Bplain`)).toBe('plain')
  })

  it('consumes an intermediate-plus-final sequence that is not a charset designation', () => {
    // `ESC # 8` is the screen-alignment test. Matching only the charset introducers left
    // its final byte behind as text.
    expect(sanitizeForTerminal(`${ESC}#8plain`)).toBe('plain')
  })

  it('stops at a byte that cannot continue the sequence, instead of eating the text after it', () => {
    // Generalising the charset case to the ECMA-48 rule regressed this: the scan ran past a
    // non-intermediate byte looking for a final one and consumed the `v` of `visible`.
    expect(sanitizeForTerminal(`${ESC}(\u{1F642}visible`)).toBe('\u{1F642}visible')
  })

  it('consumes a sequence whose final byte follows ESC directly', () => {
    expect(sanitizeForTerminal(`${ESC}7saved`)).toBe('saved')
    expect(sanitizeForTerminal(`${ESC}creset`)).toBe('reset')
  })

  it('removes a single-byte C1 CSI introducer and its sequence', () => {
    expect(sanitizeForTerminal(`${C1_CSI}31mred`)).toBe('red')
  })

  it('keeps the newline and tab a caller may lay out with', () => {
    expect(sanitizeForTerminal('a\tb\nc')).toBe('a\tb\nc')
  })

  it('drops every other control character, the carriage return included', () => {
    // A CR inside a row would return the cursor to column 0 mid-paint, which is exactly the
    // corruption the live region cannot recover from — so it goes, unlike the newline.
    expect(sanitizeForTerminal(`a${BACKSPACE}bc\rd`)).toBe('abcd')
  })

  it('leaves ordinary text, including wide characters, alone', () => {
    expect(sanitizeForTerminal('컨테이너 시작 👍')).toBe('컨테이너 시작 👍')
  })

  it('does not hang on a truncated sequence at the end of the input', () => {
    expect(sanitizeForTerminal(`text${ESC}`)).toBe('text')
    expect(sanitizeForTerminal(`text${ESC}[`)).toBe('text')
    expect(sanitizeForTerminal(`text${ESC}]0;unterminated`)).toBe('text')
  })
})
