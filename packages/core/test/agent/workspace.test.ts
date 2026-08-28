import type { WorkspaceWriter } from '../../src/agent/workspace'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'bun:test'
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_TOTAL_BYTES,
  readWorkspace,
  seedWorkspace,
  WORKSPACE_IGNORED_DIRECTORIES,
} from '../../src/agent/workspace'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'please-workspace-'))
  await writeFile(join(root, 'CLAUDE.md'), '# conventions\n')
  await mkdir(join(root, '.claude', 'agents'), { recursive: true })
  await writeFile(join(root, '.claude', 'agents', 'verifier.md'), '---\nname: verifier\n---\n')
  return root
}

async function gitFixture(): Promise<string> {
  const root = await fixture()
  await promisify(execFile)('git', ['init', '-q'], { cwd: root })
  await writeFile(join(root, '.gitignore'), 'ignored/\n')
  await mkdir(join(root, 'ignored'), { recursive: true })
  await writeFile(join(root, 'ignored', 'artifact.txt'), 'build output\n')
  await writeFile(join(root, 'untracked.md'), '# untracked\n')
  await promisify(execFile)('git', ['add', 'CLAUDE.md'], { cwd: root })
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
    const { files } = await readWorkspace(await fixture())

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
    const { files } = await readWorkspace(new URL(`file://${await fixture()}/`))

    expect(Object.keys(files)).toContain('CLAUDE.md')
  })

  it('passes an already-inlined record through', async () => {
    const inlined = { 'CLAUDE.md': '# inlined\n' }

    // The Worker case: no filesystem to read, the directory having been inlined at build time.
    expect((await readWorkspace(inlined)).files).toBe(inlined)
  })

  it('skips a file that is not UTF-8 and reports it rather than failing the read', async () => {
    const root = await fixture()
    // A PNG header: valid bytes, not valid UTF-8. Decoded leniently it becomes a string of
    // U+FFFD, which would be written into the sandbox under the original's name and reported
    // as a success — a corrupt file with nothing to notice it by. Once the ignore rules have
    // narrowed the set it is real project content, so the read continues without it.
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]))

    const { files, skipped } = await readWorkspace(root)

    expect(skipped).toEqual([{ path: 'logo.png', reason: 'binary' }])
    expect(Object.keys(files)).toContain('CLAUDE.md')
    expect(Object.keys(files)).not.toContain('logo.png')
  })

  it('honours the source repository\'s own git ignore rules', async () => {
    const { files } = await readWorkspace(await gitFixture())

    // `git ls-files -co --exclude-standard` is the tracked plus untracked-not-ignored set, so
    // the rules the project already maintains decide what travels — no parser of ours to
    // disagree with git about, and an untracked file is still carried unless git ignores it.
    expect(Object.keys(files).sort()).toEqual([
      '.claude/agents/verifier.md',
      '.gitignore',
      'CLAUDE.md',
      'untracked.md',
    ])
  })

  it('falls back to the built-in deny list when the source is not a repository', async () => {
    const root = await fixture()
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'x.js'), 'module.exports = {}\n')

    const { files } = await readWorkspace(root)

    expect(WORKSPACE_IGNORED_DIRECTORIES).toContain('node_modules')
    expect(Object.keys(files)).not.toContain('node_modules/x.js')
    expect(Object.keys(files)).toContain('CLAUDE.md')
  })

  it('reports a file over the per-file cap instead of reading it', async () => {
    const root = await fixture()
    await writeFile(join(root, 'huge.txt'), 'x'.repeat(MAX_WORKSPACE_FILE_BYTES + 1))

    const { files, skipped } = await readWorkspace(root)

    expect(skipped).toEqual([{ path: 'huge.txt', reason: 'too-large' }])
    expect(Object.keys(files)).toContain('CLAUDE.md')
  })

  it('throws when the whole workspace exceeds the total cap', async () => {
    const root = await fixture()
    // Under the per-file cap each, over the total together: the per-file rule cannot catch a
    // workspace that is simply the wrong directory, which is what the total cap is for.
    const chunk = 'x'.repeat(MAX_WORKSPACE_FILE_BYTES)
    for (let index = 0; index <= MAX_WORKSPACE_TOTAL_BYTES / MAX_WORKSPACE_FILE_BYTES; index += 1) {
      await writeFile(join(root, `chunk-${index}.txt`), chunk)
    }

    // Silence would be the worse answer here: a seed this size is a mistake about which
    // directory was handed over, so the error says what it exceeded.
    await expect(readWorkspace(root)).rejects.toThrow(String(MAX_WORKSPACE_TOTAL_BYTES))
  })

  it('refuses a repository whose file list overruns the buffer rather than walking it', async () => {
    const root = await gitFixture()
    // A `git` that outpaces `maxBuffer`, which is what a repository with an enormous file list
    // does. Falling back on that error would drop the ignore rules and start carrying the very
    // trees this path exists to leave behind — the failure reached through its own guard.
    const shim = await mkdtemp(join(tmpdir(), 'please-git-shim-'))
    await writeFile(join(shim, 'git'), '#!/bin/sh\nhead -c 70000000 /dev/zero\n', { mode: 0o755 })
    const path = process.env.PATH

    process.env.PATH = `${shim}:${path ?? ''}`
    try {
      await expect(readWorkspace(root)).rejects.toThrow(String(MAX_WORKSPACE_TOTAL_BYTES))
    }
    finally {
      process.env.PATH = path
      await rm(shim, { recursive: true, force: true })
    }
  })

  it('skips a tracked file the working tree no longer holds', async () => {
    const root = await gitFixture()
    // `git ls-files` reads the index, so a file deleted after `git add` is still listed. It is
    // not there to read and it is not a file the caller lost — nothing to report.
    await rm(join(root, 'CLAUDE.md'))

    const { files, skipped } = await readWorkspace(root)

    expect(Object.keys(files)).not.toContain('CLAUDE.md')
    expect(skipped).toEqual([])
  })

  it('raises when a listed file cannot be stat-ed for a reason other than absence', async () => {
    // Root ignores the directory mode, so there is nothing to deny and nothing to observe.
    if (process.getuid?.() === 0) {
      return
    }
    const root = await gitFixture()
    await mkdir(join(root, 'locked'), { recursive: true })
    await writeFile(join(root, 'locked', 'secret.md'), '# secret\n')
    await promisify(execFile)('git', ['add', 'locked/secret.md'], { cwd: root })
    await chmod(join(root, 'locked'), 0o000)

    try {
      // The file exists and was asked for; the seed simply cannot read it. Dropping it would
      // hand over a workspace missing a file with nothing to say so.
      await expect(readWorkspace(root)).rejects.toThrow(/EACCES|permission denied/i)
    }
    finally {
      await chmod(join(root, 'locked'), 0o700)
    }
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
