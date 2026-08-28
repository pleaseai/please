/**
 * The journal wrapper as a string, with no processes and no clock.
 *
 * The timeout the watchdog is given is a fact about the generated argv, so it is asserted
 * against the argv. A wall clock cannot make this claim: a run measured at 2.2s on a loaded
 * runner is equally consistent with "rounded up to one second" and with "correct, plus two
 * seconds of start-up" — which is how the timing version of this test in the Docker suite
 * managed to fail while the behaviour it names was perfectly intact.
 */
import { describe, expect, it } from 'bun:test'
import { journalPaths, timeoutSeconds, wrapperArgv } from '../../../src/sandbox/local'

const paths = journalPaths('/tmp/journal-root', 'probe')

function argv(command: string[], timeout?: number): string[] {
  return wrapperArgv({
    paths,
    command: command as unknown as Parameters<typeof wrapperArgv>[0]['command'],
    ...(timeout === undefined ? {} : { timeout }),
  })
}

describe('journal wrapper timeout', () => {
  it('passes a sub-second timeout as a fraction rather than rounding it up to a second', () => {
    expect(timeoutSeconds(200)).toBe('0.200')
  })

  it('keeps the fractional part of a timeout that is not a whole number of seconds', () => {
    expect(timeoutSeconds(1500)).toBe('1.500')
  })

  it('expresses a very short timeout without collapsing it to zero', () => {
    expect(timeoutSeconds(50)).toBe('0.050')
  })

  it('expresses a whole-second timeout exactly', () => {
    expect(timeoutSeconds(30_000)).toBe('30.000')
  })

  it('carries the timeout to the wrapper as its second positional parameter', () => {
    // `sh -c <script> sh <dir> <budget> <argv…>`: `$0` is consumed before `$1`, so the budget
    // sits at index 5 of the argv.
    expect(argv(['sleep', '30'], 1500)[5]).toBe('1.500')
  })

  it('passes an empty budget when no timeout was asked for, so no watchdog starts', () => {
    expect(argv(['sleep', '30'])[5]).toBe('')
  })
})

describe('journal wrapper argv', () => {
  it('passes the command as positional parameters rather than interpolating it', () => {
    const hostile = 'x\'y $(echo pwned) `echo pwned` *'

    const built = argv(['echo', hostile])

    // The property that makes a quoting function unnecessary: the argument appears in the argv
    // exactly as the caller wrote it, and nowhere inside the script.
    expect(built).toContain(hostile)
    expect(built[2]).not.toContain(hostile)
  })

  it('puts the journal directory where the script reads $1', () => {
    expect(argv(['true'])[4]).toBe(paths.dir)
  })

  it('interpolates nothing into the script at all, so it is one constant', () => {
    expect(argv(['echo', 'a'], 1000)[2]).toBe(argv(['echo', 'b'])[2])
  })
})

describe('journalPaths', () => {
  it('keeps every file of one process under that process\'s own directory', () => {
    const built = journalPaths('/tmp/journal-root', 'abc')

    expect(built.dir).toBe('/tmp/journal-root/abc')
    for (const path of Object.values(built)) {
      expect(path.startsWith(built.dir)).toBe(true)
    }
  })
})
