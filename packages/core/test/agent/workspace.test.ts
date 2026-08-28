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
})
