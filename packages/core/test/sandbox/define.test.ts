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

  it('refuses an empty port list rather than building a sandbox nothing can reach', () => {
    // `[]` is not the default: it states, explicitly, that the sandbox publishes nothing. A
    // bridged adapter reaches its runtime over a published port, so the container would come
    // up and the first connect would fail — a long way from the line that caused it.
    expect(() => resolveSandbox({ backend: stubProvider, ports: [] }))
      .toThrow(/cannot be empty/)
  })

  it.each([0, 70_000, 1.5, -1])('refuses %p, which is not a TCP port', (port) => {
    // Same argument one level down: a port the daemon will reject is worth reporting at the
    // definition rather than at the publish, and the failure names the value.
    expect(() => resolveSandbox({ backend: stubProvider, ports: [8080, port] }))
      .toThrow(new RegExp(`'${port}' is not a valid TCP port`))
  })

  it('accepts the boundaries of the valid range', () => {
    const resolved = resolveSandbox({ backend: stubProvider, ports: [1, 65_535] })

    expect(resolved.ports).toEqual([1, 65_535])
  })
})
