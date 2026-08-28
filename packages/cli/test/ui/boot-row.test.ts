/**
 * The boot row, driven without a clock.
 *
 * Animation is exercised only through the first paint: the pulse's timing is
 * `progress-pulse`'s to test, and a test that waited on real timers would buy a slower suite
 * and nothing else. What is asserted here is the part a hang would expose — that a non-TTY
 * still says what is happening, that a committed phase survives, and that a stopped row is
 * inert.
 */
import { describe, expect, it } from 'bun:test'
import { startBootRow } from '../../src/ui/boot-row'
import { visibleLength } from '../../src/ui/text'
import { createCliTheme } from '../../src/ui/theme'

const ESC = String.fromCharCode(27)
const theme = createCliTheme({ color: false })

function fakeOutput(columns = 80): {
  chunks: string[]
  columns: number
  write: (chunk: string) => void
} {
  const chunks: string[] = []
  return { chunks, columns, write: chunk => void chunks.push(chunk) }
}

function options(output: ReturnType<typeof fakeOutput>, animate: boolean) {
  return { output, theme, animate, ascii: true }
}

describe('startBootRow, without animation', () => {
  it('writes one line per phase', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, false))

    row.update('starting the container')
    row.update('bootstrapping the runtime')
    row.stop()

    expect(output.chunks).toEqual([
      'starting the container...\n',
      'bootstrapping the runtime...\n',
    ])
  })

  it('ignores a detail-only change, which without a repaint would be a line of its own', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, false))

    row.update('pulling', 'layer 1')
    row.update('pulling', 'layer 2')
    row.stop()

    expect(output.chunks).toEqual(['pulling...\n'])
  })

  it('still commits a finished phase', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, false))

    row.update('pulling')
    row.commit('image ready')
    row.stop()

    expect(output.chunks).toEqual(['pulling...\n', 'image ready\n'])
  })
})

describe('startBootRow, animating', () => {
  it('paints the phase with the pulse glyph', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, true))

    row.update('starting the container')
    row.stop()

    expect(output.chunks[0]).toContain('* starting the container...')
  })

  it('drops the trailing ellipsis once there is a detail to show instead', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, true))

    row.update('pulling', 'node:22-bookworm')
    row.stop()

    expect(output.chunks[0]).toContain('* pulling node:22-bookworm')
  })

  it('collapses a multi-line detail so one phase stays one row', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, true))

    row.update('bootstrapping', 'first\nsecond')
    row.stop()

    expect(output.chunks[0]).toContain('* bootstrapping first second')
    expect(output.chunks[0]).not.toContain('\n')
  })

  it('keeps a row inside the terminal width even when the text is wide', () => {
    const output = fakeOutput(24)
    const row = startBootRow(options(output, true))

    row.update('컨테이너를 시작하는 중', '아주 긴 상세 내용이 이어진다')
    row.stop()

    const painted = output.chunks[0]!.replace(`\r${ESC}[0J`, '')
    expect(visibleLength(painted)).toBeLessThanOrEqual(23)
  })

  it('writes a committed phase above the row it keeps painting', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, true))

    row.update('pulling')
    output.chunks.length = 0
    row.commit('image ready')
    row.stop()

    expect(output.chunks[0]).toContain('image ready\n')
    expect(output.chunks[0]).toContain('* pulling...')
  })

  it('commits as a plain line when no phase has been painted yet', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, true))

    row.commit('nothing to do')
    row.stop()

    expect(output.chunks).toEqual(['nothing to do\n'])
  })

  it('erases the row on stop and ignores everything after it', () => {
    const output = fakeOutput()
    const row = startBootRow(options(output, true))

    row.update('pulling')
    output.chunks.length = 0
    row.stop()
    row.update('too late')
    row.commit('too late')
    row.stop()

    expect(output.chunks).toEqual([`\r${ESC}[0J`])
  })
})
