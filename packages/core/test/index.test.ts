import { describe, expect, it } from 'bun:test'

describe('@pleasedev/core', () => {
  it('imports without throwing', async () => {
    const mod = await import('../src/index')

    expect(mod).toBeDefined()
  })

  it('exposes no public API yet', async () => {
    const mod = await import('../src/index')

    // The framework surface is undesigned. Adding an export is a deliberate
    // design decision — update this test in the same change that makes it.
    expect(Object.keys(mod)).toEqual([])
  })
})
