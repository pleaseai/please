/**
 * Who is allowed to remove a container, without a daemon.
 *
 * `remove()` issues `docker rm --force --volumes <name>`, and a name is shared across
 * processes by design — adoption is what makes a sandbox id resumable. So the question these
 * tests ask is not whether the removal works but whether it is issued at all, and that is
 * only visible in the argv the daemon was called with.
 *
 * The recording runs in a child process, and that is forced rather than chosen, for the same
 * reason `provider.test.ts` gives: `DOCKER_BIN` is read from `PLEASE_DOCKER_PATH` once, when
 * `docker/cli.ts` is first imported, and `bun test` shares one module registry across every
 * file — so a value set from inside a test arrives too late.
 */
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { containerName } from '../../../src/sandbox/docker/container'

const CONTAINER_MODULE = join(import.meta.dir, '..', '..', '..', 'src', 'sandbox', 'docker', 'container.ts')

/** A `docker` that records its argv and reports no container of this name. */
const FAKE_ABSENT = `#!/bin/sh
printf '%s\\n' "$*" >> "$PLEASE_ARGV_LOG"
case "$1" in container) exit 1 ;; esac
exit 0
`

/** As {@link FAKE_ABSENT}, but slow to create, so an acquisition can be observed in flight. */
const FAKE_SLOW = `#!/bin/sh
printf '%s\\n' "$*" >> "$PLEASE_ARGV_LOG"
case "$1" in
  container) exit 1 ;;
  run) sleep 0.5 ;;
esac
exit 0
`

/** A `docker` that records its argv and reports the name already taken by a running container. */
const FAKE_RUNNING = `#!/bin/sh
printf '%s\\n' "$*" >> "$PLEASE_ARGV_LOG"
case "$1" in container) printf 'running\\n' ; exit 0 ;; esac
exit 0
`

/** Drive a handle in a child process pointed at `fake`, and return the argv it produced. */
async function record(fake: string, body: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'please-docker-own-'))
  const binary = join(dir, 'docker')
  const log = join(dir, 'argv.log')
  const driver = join(dir, 'driver.ts')
  await writeFile(binary, fake)
  await chmod(binary, 0o755)
  await writeFile(driver, `
import { createContainerHandle } from ${JSON.stringify(CONTAINER_MODULE)}

const handle = createContainerHandle('owned', {
  image: 'debian:probe',
  workDir: '/srv',
  ports: [],
  prefix: 'suite',
})
${body}
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
  // A missing log is a real observation, not a broken fixture: the fake only creates it when
  // it is invoked, so "no file" is how "no docker call at all" reaches the assertions.
  const recorded = await readFile(log, 'utf-8').catch(() => '')
  return recorded.split('\n').filter(line => line.length > 0)
}

const removals = (argv: string[]): string[] => argv.filter(line => line.startsWith('rm '))

// Derived rather than written out: the digest is `containerName`'s business, and pinning its
// current output here would make a change to the hash look like an ownership regression.
const REMOVAL = `rm --force --volumes ${containerName('owned', 'suite')}`

describe('container removal ownership', () => {
  it('does not remove a running container this handle only adopted', async () => {
    const argv = await record(FAKE_RUNNING, 'await handle.ready()\nawait handle.remove()')

    // The adopted container belongs to whoever created it — very possibly a live session in
    // another process, which a name-addressed `rm --force` would kill outright.
    expect(removals(argv)).toEqual([])
    expect(argv.some(line => line.startsWith('container inspect'))).toBe(true)
  })

  it('removes a container this handle created', async () => {
    const argv = await record(FAKE_ABSENT, 'await handle.ready()\nawait handle.remove()')

    expect(argv.some(line => line.startsWith('run '))).toBe(true)
    expect(removals(argv)).toEqual([REMOVAL])
  })

  it('issues nothing for a handle that never acquired a container', async () => {
    const argv = await record(FAKE_ABSENT, 'await handle.remove()')

    expect(argv).toEqual([])
  })

  it('stays idempotent after a create', async () => {
    const argv = await record(
      FAKE_ABSENT,
      'await handle.ready()\nawait handle.remove()\nawait handle.remove()',
    )

    // The second call has nothing left to own — `remove` clears the latch — so it resolves
    // without reaching the daemon again, which is what makes repeating it safe.
    expect(removals(argv)).toEqual([REMOVAL])
  })

  it('waits for a create still in flight and removes what it produced', async () => {
    const argv = await record(
      FAKE_SLOW,
      'const pending = handle.ready()\nawait handle.remove()\nawait pending',
    )

    // The case the latch exists for: a create this handle started and then abandoned is
    // exactly the container it is responsible for removing, and deciding ownership before the
    // acquisition settles would read `undefined` and walk away from a container it made.
    expect(removals(argv)).toEqual([REMOVAL])
    expect(argv.findIndex(line => line.startsWith('run '))).toBeLessThan(argv.indexOf(REMOVAL))
  })
})
