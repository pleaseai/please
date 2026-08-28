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
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { journalPaths } from './journal'
import { readJournalState } from './process-state'

/** Characters kept in a directory name, so a sandbox id cannot reshape the path. */
function sanitize(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '-')
}

/**
 * A short, stable digest of a string, as lowercase hex.
 *
 * SHA-256, truncated. `../docker/container.ts` reaches for FNV-1a on the grounds that the
 * digest only has to separate two ids the sanitizer maps together, and that a
 * non-cryptographic hash avoids an async subtle-crypto call — but 32 bits is the wrong size
 * for what a collision costs here. Two sandboxes whose digests agree share one directory, so
 * one sandbox's `destroy()` deletes the other's working tree and journal. At 32 bits that is
 * an even-odds event after about 77,000 sandbox ids, which a long-lived host reaches.
 *
 * `node:crypto`'s `createHash` is synchronous, so the reason to avoid a real hash does not
 * apply: no `await`, no web-crypto. 64 bits of the digest puts the same even-odds point past
 * five billion ids.
 */
function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
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

/**
 * `SIGKILL` the process groups this sandbox's journal still reports as running.
 *
 * `remove()` deletes the tree those processes are writing into, and deleting a directory out
 * from under a running process does not stop it: on a POSIX filesystem the open `out`/`err`
 * descriptors survive the unlink, so a detached tree keeps running with its output going to
 * files nothing can reach. Docker has no equivalent step because `docker rm --force` takes the
 * container's whole pid namespace with it; the host has no such boundary, so the processes
 * have to be named and killed.
 *
 * The kill targets the group, which is safe for the same reason `./process.ts` gives — the
 * wrapper is spawned detached and leads its own — and is gated on `alive`, which since the
 * identity check in `./process-state.ts` means "this pid is still *this* wrapper" rather than
 * merely "this pid exists".
 *
 * Best effort throughout. A sandbox that cannot be read is one whose processes cannot be
 * named, and failing `remove()` over that would leave the tree behind as well as the process.
 */
async function reapJournalledGroups(journalRoot: string): Promise<void> {
  let entries: string[]
  try {
    entries = (await readdir(journalRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  }
  catch {
    return
  }

  await Promise.all(entries.map(async (id) => {
    const state = await readJournalState(journalPaths(journalRoot, id))
    if (state.pid === undefined || state.exit !== undefined || !state.alive) {
      return
    }
    try {
      process.kill(-state.pid, constants.signals.SIGKILL)
    }
    catch {
      // Exited between the read and the signal, which is the outcome this wanted anyway.
    }
  }))
}

export function createSandboxRoot(sandboxId: string, options: RootOptions): SandboxRoot {
  const path = join(options.root, sandboxDirName(sandboxId, options.prefix))
  const workDir = join(path, 'work')
  const journalRoot = join(path, 'journal')
  let acquisition: Promise<string> | undefined
  let teardown: Promise<void> | undefined

  const acquire = async (): Promise<string> => {
    // Both are created up front. A sandbox that exists with no journal directory would make
    // every `listProcesses()` a failed read rather than an empty list.
    await mkdir(workDir, { recursive: true })
    await mkdir(journalRoot, { recursive: true })
    return path
  }

  /**
   * Acquire, but never *while* a teardown is running.
   *
   * Clearing `acquisition` at the top of `remove()` is not enough on its own: an `exec()`
   * arriving between that line and the `rm` re-runs `acquire()`, sees its `mkdir` succeed, and
   * hands back a path the `rm` then deletes — so the sandbox reports itself ready over a tree
   * that no longer exists, and every write into it fails with `ENOENT`. Waiting the teardown
   * out first makes the recreate land after the delete instead of inside it.
   *
   * The loop rather than a single `await`, because a second `remove()` can start while this
   * one is waiting; the failure of a teardown is not this caller's to raise, so it is awaited
   * for its timing alone.
   */
  const ready = async (): Promise<string> => {
    for (let pending = teardown; pending !== undefined; pending = teardown) {
      await pending.catch(() => undefined)
    }
    return (acquisition ??= acquire().catch((cause: unknown) => {
      acquisition = undefined
      throw cause
    }))
  }

  return {
    path,
    workDir,
    journalRoot,
    ready,
    peek: async () => (await isDirectory(path) ? path : undefined),
    remove: async () => {
      acquisition = undefined
      teardown ??= (async () => {
        try {
          await reapJournalledGroups(journalRoot)
          // `force` so a sandbox that was never created is the state `remove` promises rather
          // than an error, which is the same reading `../docker/container.ts` gives
          // `no such container`.
          await rm(path, { recursive: true, force: true })
        }
        finally {
          teardown = undefined
        }
      })()
      await teardown
    },
  }
}
