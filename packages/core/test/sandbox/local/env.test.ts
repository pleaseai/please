/**
 * What a local sandbox process inherits from the host.
 *
 * A unit test rather than part of `backend.test.ts` because it asserts a policy decision, not
 * process behaviour: the backend withholds the host environment by default, and the caller has
 * to be able to hand back exactly the pieces it wants. `backend.test.ts` covers the other half
 * — that the resolved environment actually reaches a process.
 */
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_ENV_ALLOWLIST, resolveBaseEnv } from '../../../src/sandbox/local'

const SECRET = 'PLEASE_SPEC_SECRET'

afterEach(() => {
  delete process.env[SECRET]
})

describe('resolveBaseEnv', () => {
  it('withholds a host variable the allowlist does not name', () => {
    process.env[SECRET] = 'must-not-leak'

    expect(resolveBaseEnv()).not.toHaveProperty(SECRET)
  })

  it('inherits PATH, without which no command resolves', () => {
    expect(resolveBaseEnv().PATH).toBe(process.env.PATH!)
  })

  it('lets the caller opt one host variable in by name', () => {
    process.env[SECRET] = 'opted-in'

    expect(resolveBaseEnv({ [SECRET]: process.env[SECRET] })[SECRET]).toBe('opted-in')
  })

  it('lets the caller drop an inherited default by setting it undefined', () => {
    expect(resolveBaseEnv({ PATH: undefined })).not.toHaveProperty('PATH')
  })

  it('lets the caller override an inherited default rather than merging with it', () => {
    expect(resolveBaseEnv({ PATH: '/only/this' }).PATH).toBe('/only/this')
  })

  it('omits an allowlisted variable the host does not set, rather than inventing an empty one', () => {
    // An empty string is not the same as unset to a shell, and a sandbox that turns every
    // unset variable into an empty one changes how the commands in it behave.
    const absent = DEFAULT_ENV_ALLOWLIST.filter(key => process.env[key] === undefined)
    const resolved = resolveBaseEnv()

    for (const key of absent) {
      expect(resolved).not.toHaveProperty(key)
    }
  })

  it('names nothing credential-shaped in its defaults', () => {
    // The list is a security decision, and this is the shape of the mistake worth catching in
    // review: a convenience entry that carries a secret on a typical developer machine.
    const forbidden = /token|secret|key|password|credential|auth|session/i

    expect(DEFAULT_ENV_ALLOWLIST.filter(key => forbidden.test(key))).toEqual([])
  })
})
