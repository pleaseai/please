/**
 * The identity the contract's error classes exist to provide.
 *
 * These assert nothing about behaviour, and that is the point: the reason
 * `SandboxFileNotFoundError` lives on the contract rather than in each backend is that a caller
 * must be able to write one `catch` that works whichever backend it was handed. Two classes of
 * the same name in two subpaths would satisfy every behavioural test in the suite and still
 * fail that — `instanceof` answers no across them — so the claim needs a test that compares the
 * exports themselves.
 *
 * Backend subpaths are imported for their *re-export*, not for their implementations; neither
 * import reaches a daemon or the filesystem, so this runs everywhere.
 */
import { describe, expect, it } from 'bun:test'
import {
  SandboxFileNotFoundError,
  SandboxNoExitRecordError,
  SandboxWaitTimeoutError,
} from '../../../src/sandbox/contract'
import { SandboxFileNotFoundError as dockerFileNotFound } from '../../../src/sandbox/docker'
import { SandboxFileNotFoundError as localFileNotFound } from '../../../src/sandbox/local'

describe('contract error identity', () => {
  it('gives both backends the same missing-file class, not two of the same name', () => {
    expect(dockerFileNotFound).toBe(SandboxFileNotFoundError)
    expect(localFileNotFound).toBe(SandboxFileNotFoundError)
  })

  it('lets one catch match a missing file from either backend', () => {
    for (const Raised of [dockerFileNotFound, localFileNotFound]) {
      expect(new Raised('/absent')).toBeInstanceOf(SandboxFileNotFoundError)
    }
  })

  it('carries the path the caller named, so a handler need not parse the message', () => {
    expect(new SandboxFileNotFoundError('/work/absent').path).toBe('/work/absent')
  })

  it('names itself, for a log line and for a serialized error that crossed a boundary', () => {
    expect(new SandboxFileNotFoundError('/absent').name).toBe('SandboxFileNotFoundError')
  })

  it('keeps the three apart, so a caller cannot answer one question with another', () => {
    // They ask the caller for opposite things — retry, report, or treat as absent — and a
    // shared supertype would let a `catch` collapse them by accident.
    expect(new SandboxFileNotFoundError('/absent')).not.toBeInstanceOf(SandboxWaitTimeoutError)
    expect(new SandboxWaitTimeoutError('p', 1)).not.toBeInstanceOf(SandboxFileNotFoundError)
    expect(new SandboxNoExitRecordError('p')).not.toBeInstanceOf(SandboxFileNotFoundError)
  })
})
