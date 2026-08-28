/**
 * Sandbox directory naming, which decides whether two sandbox ids share a directory — and
 * whether an id can reach outside the root it was meant to stay under.
 */
import { describe, expect, it } from 'bun:test'
import { sandboxDirName } from '../../../src/sandbox/local'

describe('sandbox directory naming', () => {
  it('keeps distinct ids in distinct directories even when they sanitize alike', () => {
    expect(sandboxDirName('run/one')).not.toBe(sandboxDirName('run:one'))
  })

  it('keeps projects apart when their prefixes sanitize alike', () => {
    expect(sandboxDirName('run', 'team/a')).not.toBe(sandboxDirName('run', 'team:a'))
  })

  it('is stable for one id', () => {
    expect(sandboxDirName('run/one')).toBe(sandboxDirName('run/one'))
  })

  it('produces a single path segment from a hostile id and prefix', () => {
    // The claim that matters: nothing an id contains can add a segment or climb out of the
    // root, because `destroy()` deletes whatever this returns.
    const name = sandboxDirName('../../etc a/b:c', '/my project')

    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name).toMatch(/^[a-z0-9][\w.-]*$/i)
  })

  it('never returns a relative path segment a filesystem would treat as a parent', () => {
    expect(sandboxDirName('..')).not.toBe('..')
    expect(sandboxDirName('.')).not.toBe('.')
  })

  it('does not produce a hidden directory from an id that starts with a dot', () => {
    expect(sandboxDirName('.hidden').startsWith('.')).toBe(false)
  })
})
