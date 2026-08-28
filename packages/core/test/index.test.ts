import { describe, expect, it } from 'bun:test'

describe('@pleaseai/core', () => {
  it('imports without throwing', async () => {
    const mod = await import('../src/index')

    expect(mod).toBeDefined()
  })

  it('pins the exported surface', async () => {
    const mod = await import('../src/index')

    // This list was empty on purpose while the framework surface was undesigned. It is no
    // longer: `defineAgent` and the workspace helpers are a decision, not an accident. The
    // test still exists for the same reason it did then — an export appearing here without a
    // decision behind it should fail the suite.
    expect(Object.keys(mod).sort()).toEqual(['defineAgent', 'readWorkspace', 'seedWorkspace'])
  })
})
