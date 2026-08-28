/**
 * One directory per sandbox id, created on first use.
 *
 * This is the local backend's answer to `../docker/container.ts`, and it answers the same
 * question: what does a sandbox id actually name? Docker resolves it to a container, so
 * `destroy()` can be `docker rm --force`. There is no such object on the host, so an id
 * resolves to a directory tree **this backend creates and owns**:
 *
 * ```
 * <root>/<dirName>/
 *   work/       the sandbox's working directory — what a relative path resolves against
 *   journal/    one directory per process, read back by `getProcess` and `logs`
 * ```
 *
 * Ownership is what makes `remove()` safe to write at all. It only ever deletes
 * `<root>/<dirName>`, and `dirName` is derived here from the id — never a path a caller
 * handed in — so no `destroy()` can be aimed at a caller's own repository by passing a
 * cleverly shaped sandbox id.
 *
 * The journal lives beside `work/` rather than inside it. Docker can put it at
 * `/tmp/.please-journal` because the container's filesystem is not the caller's; here the
 * working directory is a real directory an agent lists, greps and cleans, and a journal
 * inside it would be both visible to the agent and destroyable by it.
 *
 * The acquisition is memoised, but **a failed one is not** — the rule `../docker/container.ts`
 * states for the same latch. A rejected promise left in place is replayed by every later
 * call without ever touching the filesystem again, so one transient `EACCES` would make the
 * sandbox permanently unusable rather than merely late.
 */
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Characters kept in a directory name, so a sandbox id cannot reshape the path. */
function sanitize(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '-')
}

/**
 * A short, stable digest of a string, as lowercase hex.
 *
 * FNV-1a, for the reason `../docker/container.ts` gives: the digest only has to separate two
 * ids the sanitizer maps together, so a non-cryptographic hash that needs no async
 * subtle-crypto call is the right size of tool.
 */
function shortDigest(value: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Directory name for a sandbox id.
 *
 * The sanitiser is lossy and it has to be: `..` and `a/b` are both things a caller may
 * legitimately name a sandbox and neither may survive into a path segment. So the readable
 * part is flattened and a digest carries the difference, over the *raw* prefix and the *raw*
 * id together — an id separates sandboxes, a prefix separates projects sharing one root, and
 * two prefixes that sanitize alike would otherwise share every sandbox between them.
 *
 * A leading dot is dropped as well, so a sandbox never lands as a hidden directory the
 * caller cannot see in a listing of its own root.
 */
export function sandboxDirName(sandboxId: string, prefix = 'please'): string {
  const safePrefix = sanitize(prefix).replace(/^[^a-z0-9]+/i, '') || 'please'
  // `JSON.stringify` of the pair rather than a joined string: a separator character can occur
  // inside either half — NUL included, JS strings being arbitrary UTF-16 — and a join is only
  // injective if it cannot. JSON escapes whatever would be ambiguous.
  return `${safePrefix}-${sanitize(sandboxId)}-${shortDigest(JSON.stringify([prefix, sandboxId]))}`
}

export interface RootOptions {
  /** Base directory holding one directory per sandbox id. Nothing outside it is touched. */
  root: string
  /** Prefix for directory names, so several projects can share one root. */
  prefix?: string
}

export interface SandboxRoot {
  /** `<root>/<dirName>` — the tree `remove()` deletes, and the only one it may. */
  readonly path: string
  /** The sandbox's working directory. Relative paths and commands resolve against it. */
  readonly workDir: string
  /** Where one directory per process is journalled. */
  readonly journalRoot: string
  /** Resolve the sandbox, creating its directories on first call. */
  readonly ready: () => Promise<string>
  /**
   * The path if the sandbox already exists, without creating anything.
   *
   * Discovery calls — `getProcess`, `listProcesses` — use this so that asking whether a
   * sandbox ever ran a process answers "nothing here" instead of bringing one into being as
   * a side effect of the question.
   */
  readonly peek: () => Promise<string | undefined>
  /** Delete the sandbox and everything in it. Idempotent. */
  readonly remove: () => Promise<void>
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}

export function createSandboxRoot(sandboxId: string, options: RootOptions): SandboxRoot {
  const path = join(options.root, sandboxDirName(sandboxId, options.prefix))
  const workDir = join(path, 'work')
  const journalRoot = join(path, 'journal')
  let acquisition: Promise<string> | undefined

  const acquire = async (): Promise<string> => {
    // Both are created up front. A sandbox that exists with no journal directory would make
    // every `listProcesses()` a failed read rather than an empty list.
    await mkdir(workDir, { recursive: true })
    await mkdir(journalRoot, { recursive: true })
    return path
  }

  const ready = (): Promise<string> => (acquisition ??= acquire().catch((cause: unknown) => {
    acquisition = undefined
    throw cause
  }))

  return {
    path,
    workDir,
    journalRoot,
    ready,
    peek: async () => (await isDirectory(path) ? path : undefined),
    remove: async () => {
      acquisition = undefined
      // `force` so a sandbox that was never created is the state `remove` promises rather
      // than an error, which is the same reading `../docker/container.ts` gives
      // `no such container`.
      await rm(path, { recursive: true, force: true })
    },
  }
}
