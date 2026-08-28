/**
 * The parts of the microsandbox backend that need no microVM.
 *
 * Name construction, the environment every sandbox declares, and the refusal to invent a port
 * endpoint are all decided before anything boots, so — unlike `./backend.test.ts` — these run
 * everywhere, including on a host with no native addon. They are most of what can be checked
 * about this backend without a hypervisor, and they cover the three places a mistake would be
 * silent rather than loud: two sandbox ids sharing a VM, a missing `IS_SANDBOX`, and a URL that
 * points at the host.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import {
  createMicrosandboxSandbox,
  MicrosandboxPortNotMappedError,
  sandboxEnv,
  sandboxName,
} from '../../../src/sandbox/microsandbox'

describe('sandboxName', () => {
  it('is stable for the same id and prefix', () => {
    expect(sandboxName('alpha')).toBe(sandboxName('alpha'))
  })

  it('keeps the id readable', () => {
    expect(sandboxName('alpha')).toContain('alpha')
    expect(sandboxName('alpha')).toStartWith('please-')
  })

  it('separates two ids the sanitizer maps together', () => {
    // `a/b` and `a:b` both flatten to `a-b`; sharing a name would share a whole microVM.
    expect(sandboxName('a/b')).not.toBe(sandboxName('a:b'))
  })

  it('separates two prefixes the sanitizer maps together', () => {
    // A prefix is an isolation boundary too — it is what lets two projects share one runtime.
    expect(sandboxName('id', 'team/one')).not.toBe(sandboxName('id', 'team:one'))
  })

  it('stays inside the vendor\'s 128-byte limit for a very long id', () => {
    const name = sandboxName('x'.repeat(500), 'y'.repeat(500))

    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(128)
  })

  it('separates two long ids that truncate to the same prefix', () => {
    const base = 'z'.repeat(400)

    expect(sandboxName(`${base}a`)).not.toBe(sandboxName(`${base}b`))
  })

  it('starts with an alphanumeric even when the prefix does not', () => {
    expect(sandboxName('id', '--weird')).toMatch(/^[a-z0-9]/i)
    expect(sandboxName('id', '---')).toStartWith('please-')
  })
})

describe('sandboxEnv', () => {
  it('declares IS_SANDBOX when the caller passes no environment', () => {
    expect(sandboxEnv(undefined)).toEqual({ IS_SANDBOX: '1' })
  })

  it('keeps the caller\'s own variables alongside it', () => {
    expect(sandboxEnv({ TOKEN: 'x' })).toEqual({ IS_SANDBOX: '1', TOKEN: 'x' })
  })

  it('lets the caller override it, so a non-root guest can opt out', () => {
    expect(sandboxEnv({ IS_SANDBOX: '0' }).IS_SANDBOX).toBe('0')
  })
})

describe('createMicrosandboxSandbox', () => {
  it('reports its backend name without touching the runtime', () => {
    expect(createMicrosandboxSandbox().backend).toBe('microsandbox')
  })

  it('refuses a port the sandbox does not publish, before it boots anything', async () => {
    // The refusal is decided from the caller's own map, so it needs no microVM — and answering
    // `http://127.0.0.1:8080` instead would send the caller to whatever is listening on the host.
    const sandboxes = createMicrosandboxSandbox({ ports: new Map([[3000, 13000]]) })

    await expect(sandboxes.portEndpoint('id', 8080))
      .rejects
      .toBeInstanceOf(MicrosandboxPortNotMappedError)
  })

  it('names the ports it does publish, so the fix is in the message', async () => {
    const sandboxes = createMicrosandboxSandbox({ ports: new Map([[3000, 13000]]) })

    await expect(sandboxes.portEndpoint('id', 8080)).rejects.toThrow(/published: 3000/)
  })

  it('says so plainly when it publishes none', async () => {
    await expect(createMicrosandboxSandbox().portEndpoint('id', 8080)).rejects.toThrow(/none are/)
  })
})
