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
 * Directories skipped when the source is not a git repository.
 *
 * The primary ignore mechanism is the caller's own git rules, which are already maintained and
 * already correct for their project. This list only covers a source that git cannot describe —
 * a plain directory, or a host with no git — so it is deliberately short: the entries every
 * ecosystem regenerates from source and nobody means to carry into a sandbox.
 */
export const WORKSPACE_IGNORED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'out',
]

/** Per-file ceiling. Above it the file is reported rather than read. */
export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024

/** Ceiling across the whole workspace. Above it the seed is pathological and reading stops. */
export const MAX_WORKSPACE_TOTAL_BYTES = 64 * 1024 * 1024

/** Why a file that survived the ignore rules still did not make it into the workspace. */
export interface SkippedWorkspaceFile {
  /** The path relative to the source root, in the same shape {@link WorkspaceFiles} keys use. */
  readonly path: string
  readonly reason: 'binary' | 'too-large'
}

/**
 * What a source read produced.
 *
 * `skipped` is returned rather than logged because this package has no logger, and rather than
 * handed to a callback because "reported" has to survive into something the caller can assert
 * on — a workspace that quietly lost a file is the failure mode the report exists to prevent.
 */
export interface Workspace {
  readonly files: WorkspaceFiles
  readonly skipped: readonly SkippedWorkspaceFile[]
}

/**
 * Bytes to text, refusing rather than mangling.
 *
 * A workspace carries text by construction — {@link WorkspaceFiles} is a `Record` of strings and
 * the seed writes every entry with `writeTextFile`. A non-fatal UTF-8 decode turns a PNG, a
 * `.git` pack or a prebuilt binary into a string of U+FFFD and reports success, so the sandbox
 * ends up holding a corrupt file under the original's name with nothing to notice it by. So the
 * detection stays; `undefined` is what a caller that has other files to read does with it.
 */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return undefined
  }
}

/**
 * The files git would show for the source, or `undefined` when git cannot describe it.
 *
 * `ls-files -co --exclude-standard` is exactly the tracked plus untracked-not-ignored set, which
 * means the project's own `.gitignore` — the rules its author already maintains — decides what a
 * workspace carries, with no gitignore parser of ours to disagree with git about. `-z` because a
 * newline is a legal character in a filename and the line-oriented form would split one in two.
 *
 * `node:child_process` is reached through a dynamic import for the same reason `node:fs` is: a
 * bundle that only ever passes an inlined record must not pull the host process surface in.
 */
async function gitCandidates(root: string): Promise<string[] | undefined> {
  const [{ execFile }, { promisify }] = await Promise.all([
    import('node:child_process'),
    import('node:util'),
  ])

  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      // Paths come out relative to the cwd, which is the shape `WorkspaceFiles` keys already use.
      { cwd: root, maxBuffer: MAX_WORKSPACE_TOTAL_BYTES },
    )
    return stdout.split('\0').filter(entry => entry !== '')
  }
  catch {
    // Not a repository, git not installed, git refusing the directory as unsafe — every one of
    // them means the same thing here: there are no user rules to honour, so fall back.
    return undefined
  }
}

/** The files a plain directory walk shows, minus {@link WORKSPACE_IGNORED_DIRECTORIES}. */
async function walkCandidates(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')

  // `recursive` returns paths relative to the root, dotfiles included — which is the point,
  // since `.claude/` is the most interesting thing a workspace carries.
  const entries = await readdir(root, { recursive: true })
  return entries.filter(entry => !entry
    .split(/[/\\]/)
    .some(segment => WORKSPACE_IGNORED_DIRECTORIES.includes(segment)))
}

/**
 * Read the listed candidates, reporting the ones that cannot travel as text.
 *
 * Once the ignore rules have narrowed the set, a remaining binary is real project content — an
 * icon, a font — rather than something a broad walk swept up, so refusing the whole seed over it
 * would fail the case this exists to serve. The total cap is the exception: a workspace that far
 * over the line is a mistake about which directory was handed over, and stopping says so.
 */
async function readCandidates(root: string, candidates: readonly string[]): Promise<Workspace> {
  const [{ readFile, stat }, { join }] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ])

  const files: Record<string, string> = {}
  const skipped: SkippedWorkspaceFile[] = []
  let total = 0

  for (const entry of candidates) {
    // `join` rather than a template, so a root that already ends in a separator does not
    // produce a doubled one — and a filesystem root, which has nothing to strip, still reads.
    const absolute = join(root, entry)
    // A tracked file git lists but the working tree no longer holds, or a directory entry such
    // as a submodule gitlink: neither is a file to read, and neither is worth reporting.
    const stats = await stat(absolute).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      continue
    }
    // The sandbox is Linux whatever the host is, so a Windows separator is rewritten rather
    // than carried into a container path.
    const path = entry.split('\\').join('/')
    if (stats.size > MAX_WORKSPACE_FILE_BYTES) {
      skipped.push({ path, reason: 'too-large' })
      continue
    }
    total += stats.size
    if (total > MAX_WORKSPACE_TOTAL_BYTES) {
      throw new RangeError(
        `workspace '${root}' exceeds the ${MAX_WORKSPACE_TOTAL_BYTES} byte total limit`,
      )
    }
    const content = decodeText(await readFile(absolute))
    if (content === undefined) {
      skipped.push({ path, reason: 'binary' })
      continue
    }
    files[path] = content
  }

  return { files, skipped }
}

/**
 * Read a workspace source into files.
 *
 * `node:fs` is reached through a dynamic import so that a bundle which never passes a path —
 * the Worker case, where the directory is inlined at build time — does not pull the host
 * filesystem in behind it.
 */
export async function readWorkspace(source: WorkspaceSource): Promise<Workspace> {
  if (isFiles(source)) {
    return { files: source, skipped: [] }
  }

  const { fileURLToPath } = await import('node:url')
  const root = source instanceof URL ? fileURLToPath(source) : source
  return readCandidates(root, await gitCandidates(root) ?? await walkCandidates(root))
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
    // Session-relative by construction, but not by guarantee: an inlined workspace carries
    // whatever keys the build produced, and one absolute path or `..` segment writes outside
    // the session directory entirely. Refusing is the only safe reading of an escaping path.
    if (/^[/\\]/.test(path) || path.split(/[/\\]/).includes('..')) {
      throw new TypeError(`workspace path '${path}' must stay inside the session directory`)
    }
    const target = `${sessionWorkDir}/${path}`
    await session.writeTextFile({ path: target, content })
    written.push(target)
  }
  return written
}
