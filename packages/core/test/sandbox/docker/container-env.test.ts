/**
 * What a container is told about itself before the caller says anything.
 *
 * This is a unit test rather than part of `backend.test.ts` because it asserts a policy
 * decision, not container behaviour: the backend claims `IS_SANDBOX` on the adapter's behalf,
 * and the caller has to be able to take it back. `backend.test.ts` covers the other half —
 * that the value actually reaches a process — and only runs when a daemon is reachable.
 */
import { describe, expect, it } from 'bun:test'
import { containerEnv } from '../../../src/sandbox/docker'

describe('containerEnv', () => {
  it('declares IS_SANDBOX when the caller passes no environment', () => {
    expect(containerEnv(undefined)).toEqual({ IS_SANDBOX: '1' })
  })

  it('keeps the caller\'s own variables alongside it', () => {
    expect(containerEnv({ PROBE: 'kept' })).toEqual({ IS_SANDBOX: '1', PROBE: 'kept' })
  })

  it('lets the caller override it, so a non-root container can opt out', () => {
    expect(containerEnv({ IS_SANDBOX: '0' })).toEqual({ IS_SANDBOX: '0' })
  })
})
