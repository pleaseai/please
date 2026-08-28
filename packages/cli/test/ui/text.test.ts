/**
 * Width measurement, which is the reason this module exists rather than `String.length`.
 *
 * Every assertion below is one `.length` would get wrong.
 */
import { describe, expect, it } from 'bun:test'
import { clipVisible, ellipsize, sliceVisible, visibleLength } from '../../src/ui/text'

const ESC = String.fromCharCode(27)
const RED = `${ESC}[31m`
const RESET = `${ESC}[0m`

describe('visibleLength', () => {
  it('counts a Hangul syllable as two cells', () => {
    expect('시작'.length).toBe(2)
    expect(visibleLength('시작')).toBe(4)
  })

  it('counts an emoji as two cells however many code points it holds', () => {
    expect(visibleLength('👍')).toBe(2)
    expect(visibleLength('👨‍👩‍👦')).toBe(2)
  })

  it('counts a combining mark as part of the character it attaches to', () => {
    expect(visibleLength('é')).toBe(1)
  })

  it('counts an escape sequence as nothing', () => {
    expect(visibleLength(`${RED}red${RESET}`)).toBe(3)
  })
})

describe('sliceVisible', () => {
  it('drops a wide grapheme that would straddle the limit rather than half-printing it', () => {
    expect(sliceVisible('시작', 3)).toBe('시')
  })

  it('cuts on the cell, not the code unit', () => {
    expect(sliceVisible('컨테이너', 4)).toBe('컨테')
  })

  it('carries trailing styling past the cut so the slice does not end mid-sequence', () => {
    expect(sliceVisible(`ab${RESET}`, 2)).toBe(`ab${RESET}`)
  })

  it('returns nothing for a non-positive width', () => {
    expect(sliceVisible('abc', 0)).toBe('')
  })
})

describe('clipVisible', () => {
  it('returns the input untouched when it already fits', () => {
    expect(clipVisible('abc', 3)).toBe('abc')
  })

  it('resets styling when the cut left a sequence open', () => {
    expect(clipVisible(`${RED}abcdef`, 3)).toBe(`${RED}abc${RESET}`)
  })
})

describe('ellipsize', () => {
  it('leaves text that fits alone', () => {
    expect(ellipsize('abc', 3)).toBe('abc')
  })

  it('marks a cut with an ellipsis, inside the width', () => {
    expect(ellipsize('abcdef', 4)).toBe('abc…')
    expect(visibleLength(ellipsize('abcdef', 4))).toBe(4)
  })

  it('keeps a wide-character result inside the width', () => {
    expect(visibleLength(ellipsize('컨테이너 시작', 5))).toBeLessThanOrEqual(5)
  })

  it('degrades to a bare ellipsis at width 1 and nothing below it', () => {
    expect(ellipsize('abcdef', 1)).toBe('…')
    expect(ellipsize('abcdef', 0)).toBe('')
  })
})
