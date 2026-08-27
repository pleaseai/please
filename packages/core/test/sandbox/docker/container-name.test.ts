/**
 * Container naming, which decides whether two sandbox ids share a container.
 */
import { describe, expect, it } from 'bun:test'
import { containerName } from '../../../src/sandbox/docker'

describe('container naming', () => {
  it('keeps distinct ids on distinct containers even when they sanitize alike', () => {
    expect(containerName('run/one')).not.toBe(containerName('run:one'))
  })

  it('is stable for one id', () => {
    expect(containerName('run/one')).toBe(containerName('run/one'))
  })

  it('produces a name the daemon accepts from a hostile id and prefix', () => {
    const name = containerName('a b/c:d', '/my project')

    expect(name).toMatch(/^[a-z0-9][\w.-]*$/i)
  })
})
