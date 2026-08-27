/**
 * The journal wrapper as a string, with no daemon and no clock.
 *
 * The timeout the watchdog is given is a fact about the generated script, so it is asserted
 * against the script. A wall clock cannot make this claim: a run measured at 2.2s on a loaded
 * runner is equally consistent with "rounded up to one second" and with "correct, plus two
 * seconds of `docker exec` overhead" — which is how the timing version of this test managed to
 * fail while the behaviour it names was perfectly intact.
 */
import { describe, expect, it } from 'bun:test'
import { journalledCommand, journalPaths } from '../../../src/sandbox/docker/journal'

/** The seconds literal the watchdog sleeps before it fires, as the wrapper spells it. */
function watchdogSleep(timeout?: number): string | undefined {
  const script = journalledCommand({
    paths: journalPaths('probe'),
    command: ['sleep', '30'],
    meta: { id: 'probe', command: ['sleep', '30'], startedAt: new Date(0).toISOString() },
    ...(timeout === undefined ? {} : { timeout }),
  })
  return /\( sleep (\S+) ;/.exec(script)?.[1]
}

describe('journal wrapper timeout', () => {
  it('passes a sub-second timeout as a fraction rather than rounding it up to a second', () => {
    expect(watchdogSleep(200)).toBe('0.200')
  })

  it('keeps the fractional part of a timeout that is not a whole number of seconds', () => {
    expect(watchdogSleep(1500)).toBe('1.500')
  })

  it('expresses a very short timeout without collapsing it to zero', () => {
    expect(watchdogSleep(50)).toBe('0.050')
  })

  it('expresses a whole-second timeout exactly', () => {
    expect(watchdogSleep(30_000)).toBe('30.000')
  })

  it('starts no watchdog at all when no timeout was asked for', () => {
    expect(watchdogSleep()).toBeUndefined()
  })
})
