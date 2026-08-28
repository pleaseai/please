/**
 * The env wrapper, without an interpreter.
 *
 * `envArgv` is the whole of this backend's per-exec env — the vendor accepts the field and
 * ignores it — so the argv it builds is worth pinning here as well as end-to-end. What matters
 * is that nothing the caller supplies ever lands in the script text.
 */
import { describe, expect, it } from 'bun:test'
import { ENV_WRAPPER_SCRIPT, envArgv, JustBashEnvNameError } from '../../../src/sandbox/just-bash'

describe('envArgv', () => {
  it('hands back the caller\'s own argv when there is nothing to export', () => {
    expect(envArgv(['echo', 'hi'])).toEqual(['echo', 'hi'])
    expect(envArgv(['echo', 'hi'], {})).toEqual(['echo', 'hi'])
  })

  it('puts the constant script in front, with names and values as positional words', () => {
    expect(envArgv(['echo', 'hi'], { A: '1', B: '2' })).toEqual([
      'sh',
      '-c',
      ENV_WRAPPER_SCRIPT,
      'sh',
      '2',
      'A=1',
      'B=2',
      'echo',
      'hi',
    ])
  })

  it('never interpolates a value into the script', () => {
    const argv = envArgv(['true'], { A: '$(echo pwned) ; echo pwned' })

    expect(argv[2]).toBe(ENV_WRAPPER_SCRIPT)
    expect(argv[5]).toBe('A=$(echo pwned) ; echo pwned')
  })

  it('counts the exports rather than marking their end, so a value may look like anything', () => {
    // A separator word could be forged by a value; a count cannot.
    const argv = envArgv(['true'], { A: '--', B: 'true' })

    expect(argv[4]).toBe('2')
    expect(argv.slice(-1)).toEqual(['true'])
  })

  it('rejects a name the shell could not export as one word', () => {
    expect(() => envArgv(['true'], { 'A B': 'x' })).toThrow(JustBashEnvNameError)
    expect(() => envArgv(['true'], { '1A': 'x' })).toThrow(JustBashEnvNameError)
    expect(() => envArgv(['true'], { 'A=B': 'x' })).toThrow(JustBashEnvNameError)
  })

  it('accepts the names a shell actually uses', () => {
    expect(() => envArgv(['true'], { _PRIVATE: 'x', PATH: '/bin', http_proxy: 'x' })).not.toThrow()
  })
})
