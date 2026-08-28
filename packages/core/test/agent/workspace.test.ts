import type { WorkspaceWriter } from '../../src/agent/workspace'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { readWorkspace, seedWorkspace } from '../../src/agent/workspace'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'please-workspace-'))
  await writeFile(join(root, 'CLAUDE.md'), '# conventions\n')
  await mkdir(join(root, '.claude', 'agents'), { recursive: true })
  await writeFile(join(root, '.claude', 'agents', 'verifier.md'), '---\nname: verifier\n---\n')
  return root
}

function recorder(): { writes: { path: string, content: string }[] } & WorkspaceWriter {
  const writes: { path: string, content: string }[] = []
  return {
    writes,
    writeTextFile: async (options) => {
      writes.push(options)
    },
  }
}

describe('readWorkspace', () => {
  it('reads a directory recursively, dotfiles included', async () => {
    const files = await readWorkspace(await fixture())

    // `.claude/` is the reason this walks hidden entries at all: it is what carries an
    // existing Claude Code project's agents, skills and settings into a sandbox.
    expect(Object.keys(files).sort()).toEqual(['.claude/agents/verifier.md', 'CLAUDE.md'])
    expect(files['CLAUDE.md']).toBe('# conventions\n')
  })

  it('reads a source that already ends in a separator', async () => {
    const root = await fixture()

    // The path is built with `join` rather than a template, so a trailing separator does not
    // produce a doubled one. What that spelling actually rescued is the filesystem root, where
    // the old strip left an empty string and every read failed with ENOENT — and a test cannot
    // walk `/` to prove it, so this pins the neighbouring case the same line serves.
    expect(await readWorkspace(`${root}/`)).toEqual(await readWorkspace(root))
  })

  it('accepts a file URL', async () => {
    const files = await readWorkspace(new URL(`file://${await fixture()}/`))

    expect(Object.keys(files)).toContain('CLAUDE.md')
  })

  it('passes an already-inlined record through', async () => {
    const inlined = { 'CLAUDE.md': '# inlined\n' }

    // The Worker case: no filesystem to read, the directory having been inlined at build time.
    expect(await readWorkspace(inlined)).toBe(inlined)
  })

  it('refuses a file that is not UTF-8 rather than seeding a mangled copy of it', async () => {
    const root = await fixture()
    // A PNG header: valid bytes, not valid UTF-8. Decoded leniently it becomes a string of
    // U+FFFD, which would be written into the sandbox under the original's name and reported
    // as a success — a corrupt file with nothing to notice it by.
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]))

    await expect(readWorkspace(root)).rejects.toThrow(/logo\.png/)
  })
})

describe('seedWorkspace', () => {
  it('writes every file under the session directory, preserving relative paths', async () => {
    const session = recorder()

    const written = await seedWorkspace(session, '/work/session-1', {
      'CLAUDE.md': '# conventions\n',
      '.claude/settings.json': '{}',
    })

    expect(session.writes).toEqual([
      { path: '/work/session-1/CLAUDE.md', content: '# conventions\n' },
      { path: '/work/session-1/.claude/settings.json', content: '{}' },
    ])
    expect(written).toEqual(['/work/session-1/CLAUDE.md', '/work/session-1/.claude/settings.json'])
  })

  it('refuses an absolute key rather than writing outside the session directory', async () => {
    const session = recorder()

    // Session-relative by construction, not by guarantee: an inlined workspace carries whatever
    // keys the build produced, and `${sessionWorkDir}/${'/etc/profile'}` is just `/etc/profile`
    // with a prefix that stops mattering — a write straight into the container's own filesystem.
    await expect(seedWorkspace(session, '/work/session-1', { '/etc/profile': 'export X=1\n' }))
      .rejects
      .toThrow(/\/etc\/profile/)
    // Refused before the write, not after it: a guard that reported the path once the file was
    // already there would name the damage rather than prevent it.
    expect(session.writes).toEqual([])
  })

  it('refuses a key that climbs out with a .. segment', async () => {
    const session = recorder()

    // The same escape by the other route, and the one a relative-looking key hides: this
    // resolves to `/work/.ssh/authorized_keys`, a sibling of the session rather than a child.
    await expect(seedWorkspace(session, '/work/session-1', {
      '../.ssh/authorized_keys': 'ssh-rsa AAAA\n',
    })).rejects.toThrow(/\.\.\/\.ssh\/authorized_keys/)
    expect(session.writes).toEqual([])
  })

  it('names the offending key even when good ones precede it', async () => {
    const session = recorder()

    // Object key order is insertion order, so the guard is reached mid-loop here — which is
    // what proves it runs per key rather than once over the whole record.
    await expect(seedWorkspace(session, '/work/session-1', {
      'CLAUDE.md': '# conventions\n',
      '../escape.txt': 'no',
    })).rejects.toThrow(/escape\.txt/)
    expect(session.writes).toEqual([{ path: '/work/session-1/CLAUDE.md', content: '# conventions\n' }])
  })
})
