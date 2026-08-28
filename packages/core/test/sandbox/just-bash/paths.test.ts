/**
 * Path resolution inside the virtual filesystem.
 *
 * Unlike `../local`, there is no host path to escape to — a `..` that climbs past the root
 * climbs out of the interpreter's own tree. These cases pin the shape of what is handed to it.
 */
import { describe, expect, it } from 'bun:test'
import { resolveVirtualPath } from '../../../src/sandbox/just-bash'

describe('resolveVirtualPath', () => {
  it('resolves a relative path against the working directory', () => {
    expect(resolveVirtualPath('/work', 'file.txt')).toBe('/work/file.txt')
    expect(resolveVirtualPath('/work', 'nested/file.txt')).toBe('/work/nested/file.txt')
  })

  it('leaves an absolute path alone', () => {
    expect(resolveVirtualPath('/work', '/etc/passwd')).toBe('/etc/passwd')
  })

  it('does not double a separator when the working directory carries one', () => {
    expect(resolveVirtualPath('/work/', 'file.txt')).toBe('/work/file.txt')
    expect(resolveVirtualPath('/work///', 'file.txt')).toBe('/work/file.txt')
  })
})
