import type { SandboxBackendContext, SandboxProvider } from '../../src/sandbox'
import { describe, expect, it } from 'bun:test'
import { DEFAULT_PORTS, DEFAULT_WORK_DIR, defineSandbox, resolveSandbox } from '../../src/sandbox'

function stubProvider(): SandboxProvider {
  return {
    backend: 'stub',
    session: () => {
      throw new Error('not used')
    },
    portEndpoint: async () => ({ url: 'http://127.0.0.1:1' }),
  }
}

describe('defineSandbox', () => {
  it('returns the definition unchanged', () => {
    const backend = (): SandboxProvider => stubProvider()
    const definition = defineSandbox({ backend })

    expect(definition.backend).toBe(backend)
  })
})

describe('resolveSandbox', () => {
  it('applies the defaults and hands them to the backend', () => {
    let seen: SandboxBackendContext | undefined
    const resolved = resolveSandbox({
      backend: (context) => {
        seen = context
        return stubProvider()
      },
    })

    expect(resolved.workDir).toBe(DEFAULT_WORK_DIR)
    expect(resolved.ports).toEqual(DEFAULT_PORTS)
    // The placement the backend is given is the placement the harness provider will be given —
    // which is the whole reason `backend` is a factory rather than a constructed provider.
    expect(seen).toEqual({ workDir: DEFAULT_WORK_DIR, ports: DEFAULT_PORTS })
  })

  it('prefers what the definition states', () => {
    let seen: SandboxBackendContext | undefined
    const resolved = resolveSandbox({
      backend: (context) => {
        seen = context
        return stubProvider()
      },
      workDir: '/srv',
      ports: [3000, 3001],
    })

    expect(seen).toEqual({ workDir: '/srv', ports: [3000, 3001] })
    expect(resolved.sandboxes.backend).toBe('stub')
  })
})
