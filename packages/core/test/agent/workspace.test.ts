import type { WorkspaceWriter } from '../../src/agent/workspace'
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
