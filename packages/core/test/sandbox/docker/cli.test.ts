/**
 * Argv redaction, which needs no daemon: the point is what a failed command is allowed to
 * say, and a `DockerCommandError` is constructible without one.
 */
import { describe, expect, it } from 'bun:test'
import { DockerCommandError } from '../../../src/sandbox/docker'
import { redactArgs } from '../../../src/sandbox/docker/cli'

describe('docker argv redaction', () => {
  it('keeps the key of an --env pair and drops the value', () => {
    expect(redactArgs(['run', '--env', 'ANTHROPIC_API_KEY=sk-secret'])).toEqual([
      'run',
      '--env',
      'ANTHROPIC_API_KEY=<redacted>',
    ])
  })

  it('redacts the -e and --env=KEY=value spellings too', () => {
    expect(redactArgs(['-e', 'TOKEN=abc', '--env=OTHER=def'])).toEqual([
      '-e',
      'TOKEN=<redacted>',
      '--env=OTHER=<redacted>',
    ])
  })

  it('leaves ordinary arguments alone', () => {
    const args = ['run', '--detach', '--publish', '127.0.0.1::8080', 'debian:bookworm-slim']

    expect(redactArgs(args)).toEqual(args)
  })

  it('never reproduces a secret in the error a failed command throws', () => {
    const error = new DockerCommandError(
      ['run', '--env', 'ANTHROPIC_API_KEY=sk-secret', 'node:22-bookworm'],
      125,
      'boom',
    )

    expect(error.message).not.toContain('sk-secret')
    expect(error.args).not.toContain('ANTHROPIC_API_KEY=sk-secret')
    expect(error.message).toContain('ANTHROPIC_API_KEY=<redacted>')
  })
})
