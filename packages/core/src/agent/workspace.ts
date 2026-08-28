/**
 * The workspace — the one route an authored file has into a harness runtime.
 *
 * There is no mount option. Files reach a session through `onSession` and `writeTextFile`, and
 * that route carries more than data: the Claude Agent SDK loads `CLAUDE.md`, `.claude/skills/`,
 * `.claude/agents/`, `.claude/commands/` and `.claude/settings.json` from the session's own
 * working directory, because the bridge starts it without `settingSources` and the omitted
 * default reads user, project and local sources alike. Hooks and permission rules seeded this
 * way have been measured to bind. So a directory handed to `defineAgent({ workspace })` is not
 * a file drop — it is how an existing Claude Code project is carried into a sandbox unchanged.
 *
 * Two shapes, for two runtimes. A path is read from the host filesystem, which is what a local
 * run does. A `Record` of path to content is what a Worker gets, where there is no filesystem
 * to read and the directory has to be inlined into the bundle ahead of time.
 */

/** Session-relative POSIX paths to their contents. The shape a Worker can carry. */
export type WorkspaceFiles = Readonly<Record<string, string>>

/**
 * Where a workspace comes from.
 *
 * Prefer `new URL('./workspace/', import.meta.url)` over a bare string: a string is resolved
 * against the process's working directory, which is a property of how the program was launched
 * rather than of where the module lives.
 */
export type WorkspaceSource = string | URL | WorkspaceFiles

function isFiles(source: WorkspaceSource): source is WorkspaceFiles {
  return typeof source !== 'string' && !(source instanceof URL)
}

/**
 * Bytes to text, refusing rather than mangling.
 *
 * A workspace carries text by construction — {@link WorkspaceFiles} is a `Record` of strings and
 * the seed writes every entry with `writeTextFile`. A non-fatal UTF-8 decode turns a PNG, a
 * `.git` pack or a prebuilt binary into a string of U+FFFD and reports success, so the sandbox
 * ends up holding a corrupt file under the original's name with nothing to notice it by. Naming
 * the file is the only useful answer.
 */
function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw new TypeError(`workspace file '${path}' is not valid UTF-8; a workspace carries text only`)
  }
}

/**
 * Read a workspace source into files.
 *
 * `node:fs` is reached through a dynamic import so that a bundle which never passes a path —
 * the Worker case, where the directory is inlined at build time — does not pull the host
 * filesystem in behind it.
 */
export async function readWorkspace(source: WorkspaceSource): Promise<WorkspaceFiles> {
  if (isFiles(source)) {
    return source
  }

  const [{ readdir, readFile, stat }, { fileURLToPath }] = await Promise.all([
    import('node:fs/promises'),
    import('node:url'),
  ])

  const root = (source instanceof URL ? fileURLToPath(source) : source).replace(/[/\\]+$/, '')
  const files: Record<string, string> = {}
  // `recursive` returns paths relative to the root, dotfiles included — which is the point,
  // since `.claude/` is the most interesting thing a workspace carries.
  for (const entry of await readdir(root, { recursive: true })) {
    const absolute = `${root}/${entry}`
    if (!(await stat(absolute)).isFile()) {
      continue
    }
    // The sandbox is Linux whatever the host is, so a Windows separator is rewritten rather
    // than carried into a container path.
    files[entry.split('\\').join('/')] = decodeText(await readFile(absolute), absolute)
  }
  return files
}

/**
 * What `seedWorkspace` needs of a session — the AI SDK's write surface, narrowed.
 *
 * `PromiseLike` rather than `Promise` because that is what the harness session promises, and a
 * narrowing that demands more than the real type offers would not accept it.
 */
export interface WorkspaceWriter {
  writeTextFile: (options: { path: string, content: string }) => PromiseLike<unknown>
}

/** Write every file into the session's working directory, preserving relative paths. */
export async function seedWorkspace(
  session: WorkspaceWriter,
  sessionWorkDir: string,
  files: WorkspaceFiles,
): Promise<readonly string[]> {
  const written: string[] = []
  for (const [path, content] of Object.entries(files)) {
    const target = `${sessionWorkDir}/${path}`
    await session.writeTextFile({ path: target, content })
    written.push(target)
  }
  return written
}
