/**
 * The repaint's cursor arithmetic, which is the only part that can go wrong silently.
 *
 * A wrong row count does not throw — it eats a line of scrollback on every later paint — so
 * the assertions are about the exact sequences written, not about what the screen looks like.
 */
import { describe, expect, it } from 'bun:test'
import { LiveRegion } from '../../src/ui/live-region'

const ESC = String.fromCharCode(27)
const CLEAR_TO_END = `${ESC}[0J`
const SYNC_START = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`

function fakeOutput(): { chunks: string[], write: (chunk: string) => void } {
  const chunks: string[] = []
  return { chunks, write: chunk => void chunks.push(chunk) }
}

describe('LiveRegion', () => {
  it('starts from a carriage return when nothing has been painted yet', () => {
    const output = fakeOutput()

    new LiveRegion(output, { synchronized: false }).update(['one'])

    expect(output.chunks).toEqual([`\r${CLEAR_TO_END}one`])
  })

  it('moves up one line short of the row count, because the cursor ends on the last row', () => {
    const output = fakeOutput()
    const region = new LiveRegion(output, { synchronized: false })

    region.update(['one', 'two', 'three'])
    output.chunks.length = 0
    region.update(['four', 'five', 'six'])

    expect(output.chunks).toEqual([`${ESC}[2F${CLEAR_TO_END}four\nfive\nsix`])
  })

  it('uses a carriage return rather than CPL for a single row, which CPL cannot express', () => {
    const output = fakeOutput()
    const region = new LiveRegion(output, { synchronized: false })

    region.update(['one'])
    output.chunks.length = 0
    region.update(['two'])

    expect(output.chunks).toEqual([`\r${CLEAR_TO_END}two`])
  })

  it('terminates each committed row so it scrolls away above the live region', () => {
    const output = fakeOutput()
    const region = new LiveRegion(output, { synchronized: false })

    region.update(['live'])
    output.chunks.length = 0
    region.flush(['done'], ['live'])

    expect(output.chunks).toEqual([`\r${CLEAR_TO_END}done\nlive`])
  })

  it('counts only the live rows, not the rows it committed', () => {
    const output = fakeOutput()
    const region = new LiveRegion(output, { synchronized: false })

    region.flush(['a', 'b', 'c'], ['live'])
    output.chunks.length = 0
    region.update(['live again'])

    expect(output.chunks).toEqual([`\r${CLEAR_TO_END}live again`])
  })

  it('wraps a paint in synchronized-update markers by default', () => {
    const output = fakeOutput()

    new LiveRegion(output).update(['one'])

    expect(output.chunks).toEqual([`${SYNC_START}\r${CLEAR_TO_END}one${SYNC_END}`])
  })

  it('erases the region and forgets its rows, so the next paint does not move up', () => {
    const output = fakeOutput()
    const region = new LiveRegion(output, { synchronized: false })

    region.update(['one', 'two'])
    output.chunks.length = 0
    region.clear()
    region.update(['three'])

    expect(output.chunks).toEqual([
      `${ESC}[1F${CLEAR_TO_END}`,
      `\r${CLEAR_TO_END}three`,
    ])
  })

  it('clears from the current line when it has never painted', () => {
    const output = fakeOutput()

    new LiveRegion(output, { synchronized: false }).clear()

    expect(output.chunks).toEqual([`\r${CLEAR_TO_END}`])
  })
})
