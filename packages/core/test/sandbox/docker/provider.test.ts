/**
 * The `docker()` factory, without a daemon.
 *
 * What is in question is not container behaviour — `backend.test.ts` covers that against a
 * real daemon — but whether the placement a definition resolves reaches the container the
 * backend would create. That is only visible in the argv, so the daemon is replaced by a
 * script that records what it was called with.
 *
 * The recording runs in a child process, and that is forced rather than chosen. `DOCKER_BIN`
 * is read from `PLEASE_DOCKER_PATH` once, when `docker/cli.ts` is first imported, and `bun
 * test` shares one module registry across every file — so a value set from inside a test
 * arrives too late. Pointing a whole process at the fake is what makes the substitution
 * deterministic no matter which suite loaded the module first.
 */
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { resolveSandbox } from '../../../src/sandbox'
import { docker } from '../../../src/sandbox/docker'

const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..', 'src')

/**
 * A `docker` that records its argv and refuses to be a container.
 *
 * `container inspect` exits non-zero so the backend takes the create path, and everything
 * after answers empty — `docker port` included, which is what makes the port lookup fail once
 * the container has been "created". Nothing here has to succeed: the argv is the observation.
 */
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$PLEASE_ARGV_LOG"
case "$1" in container) exit 1 ;; esac
exit 0
`

/** Resolve a sandbox backed by `docker()` in a child process, and return the argv it produced. */
async function recordCreation(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'please-docker-'))
  const binary = join(dir, 'docker')
  const log = join(dir, 'argv.log')
  const driver = join(dir, 'driver.ts')
  await writeFile(binary, FAKE_DOCKER)
  await chmod(binary, 0o755)
  await writeFile(driver, `
import { docker } from ${JSON.stringify(join(SOURCE_ROOT, 'sandbox', 'docker', 'index.ts'))}
import { resolveSandbox } from ${JSON.stringify(join(SOURCE_ROOT, 'sandbox', 'index.ts'))}

const { sandboxes } = resolveSandbox({
  backend: docker({ image: 'debian:probe', namePrefix: 'suite', env: { PROBE: 'kept' } }),
  workDir: '/srv',
  ports: [4000, 4001],
})
// The first call that needs the daemon, which is what creates the container. It fails, because
// the fake publishes no address — after the creation this test is about.
await sandboxes.portEndpoint('probe', 4000).catch(() => {})
`)

  const child = Bun.spawn([process.execPath, 'run', driver], {
    env: { ...process.env, PLEASE_DOCKER_PATH: binary, PLEASE_ARGV_LOG: log },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(child.stderr).text()
  if (await child.exited !== 0) {
    throw new Error(`driver failed: ${stderr}`)
  }
  return (await readFile(log, 'utf-8')).split('\n').filter(line => line.length > 0)
}

describe('docker backend factory', () => {
  it('creates the container with the placement the definition resolved', async () => {
    const run = (await recordCreation()).find(line => line.startsWith('run '))

    // `workDir` and `ports` arrive from the placement rather than from the caller, which is
    // the whole reason `backend` is a factory: the two cannot disagree.
    expect(run).toContain('--workdir /srv')
    expect(run).toContain('--publish 127.0.0.1::4000')
    expect(run).toContain('--publish 127.0.0.1::4001')
    // And the options the factory was handed itself survive the placement being applied.
    expect(run).toContain('--env PROBE=kept')
    expect(run).toContain('--env IS_SANDBOX=1')
    expect(run).toContain('--name suite-probe-')
    expect(run).toContain('debian:probe')
  })

  it('builds a docker-backed provider from the definition', () => {
    const { sandboxes } = resolveSandbox({ backend: docker({ image: 'debian:probe' }) })

    expect(sandboxes.backend).toBe('docker')
  })
})
