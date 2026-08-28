/**
 * The chrome, rendered without colour.
 *
 * Colour is switched off in every case so the assertions are about layout — alignment,
 * indentation, sanitization — rather than about which escape a palette happens to choose.
 */
import { describe, expect, it } from 'bun:test'
import { visibleLength } from '../../src/ui/text'
import {
  createCliTheme,
  renderCliBanner,
  renderCliSection,
  renderCliTaggedLine,
} from '../../src/ui/theme'

const ESC = String.fromCharCode(27)
const theme = createCliTheme({ color: false })

describe('createCliTheme', () => {
  it('emits no escapes when colour is off', () => {
    expect(theme.color).toBe(false)
    expect(theme.heading('title')).toBe('title')
    expect(theme.danger('boom')).toBe('boom')
  })

  it('emits escapes when colour is forced on', () => {
    expect(createCliTheme({ color: true }).danger('boom')).toContain(ESC)
  })
})

describe('renderCliBanner', () => {
  it('rules the title to its own length', () => {
    expect(renderCliBanner(theme, { title: 'please dev' })).toBe('please dev\n==========')
  })

  it('adds the subtitle on its own line', () => {
    expect(renderCliBanner(theme, { title: 'dev', subtitle: 'docker' }))
      .toBe('dev\n===\ndocker')
  })

  it('rules a wide title to its cell width, not its code-unit length', () => {
    // '컨테이너 시작' is 7 code units and 13 cells. Ruling by `.length` leaves the rule
    // visibly short of the title — the exact mistake `text.ts` exists to prevent.
    const [title = '', rule = ''] = renderCliBanner(theme, { title: '컨테이너 시작' }).split('\n')

    expect(visibleLength(rule)).toBe(visibleLength(title))
    expect(visibleLength(rule)).toBe(13)
  })
})

describe('renderCliSection', () => {
  it('aligns values to one column past the widest label', () => {
    expect(renderCliSection(theme, {
      title: 'sandbox',
      rows: [
        { label: 'image', value: 'node:22-bookworm' },
        { label: 'workDir', value: '/work' },
      ],
    })).toBe('sandbox\nimage    node:22-bookworm\nworkDir  /work')
  })

  it('indents a multi-line value under its own column', () => {
    expect(renderCliSection(theme, {
      title: 'error',
      rows: [{ label: 'cause', value: 'first\nsecond' }],
    })).toBe('error\ncause  first\n       second')
  })

  it('strips escape sequences a value arrived with', () => {
    expect(renderCliSection(theme, {
      title: 'sandbox',
      rows: [{ label: 'id', value: `${ESC}[31mabc123` }],
    })).toBe('sandbox\nid  abc123')
  })
})

describe('renderCliTaggedLine', () => {
  it('upper-cases the tag and brackets it', () => {
    expect(renderCliTaggedLine(theme, { tag: 'docker', message: 'image ready' }))
      .toBe('[DOCKER] image ready')
  })

  it('indents continuation lines past the tag', () => {
    expect(renderCliTaggedLine(theme, { tag: 'x', message: 'one\ntwo' }))
      .toBe('[X] one\n    two')
  })

  it('aligns a continuation under a wide tag, which is wider than its code units', () => {
    expect(renderCliTaggedLine(theme, { tag: '도커', message: 'a\nb' }))
      .toBe('[도커] a\n       b')
  })
})
