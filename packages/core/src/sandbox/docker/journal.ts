/**
 * The process journal — what `docker exec` forgets, written to the container's filesystem.
 *
 * The contract requires a process to outlive the call that started it: `getProcess(id)` and
 * `logs({ replay: true })` are read *after* it exits. `docker exec -d` gives none of that —
 * detaching discards the streams, and an exec id stops resolving once the daemon reaps it.
 * So each process is wrapped in a shell that redirects both streams to files and records its
 * own exit status beside them, which is the same shape `@pleaseai/sandbox-e2b` arrived at
 * for the same reason.
 *
 * stdout and stderr stay in separate files rather than one interleaved log because
 * `ProcessLogEvent` is tagged per stream: a caller parsing NDJSON on stdout must not have to
 * filter out whatever the process wrote to stderr.
 */
import type { SandboxCommand } from '../contract'
import { quoteArg, quoteArgv } from './shell-quote'

/** Where every journal lives inside the container. */
export const JOURNAL_ROOT = '/tmp/.please-journal'

export interface JournalPaths {
  dir: string
  meta: string
  pid: string
  stdout: string
  stderr: string
  exit: string
}

/** The five paths one process's journal is made of. */
export function journalPaths(processId: string, root: string = JOURNAL_ROOT): JournalPaths {
  const dir = `${root}/${processId}`
  return {
    dir,
    meta: `${dir}/meta`,
    pid: `${dir}/pid`,
    stdout: `${dir}/out`,
    stderr: `${dir}/err`,
    exit: `${dir}/exit`,
  }
}

/** What {@link journalledCommand} records so `status()` can answer without the process. */
export interface JournalMeta {
  id: string
  command: SandboxCommand
  cwd?: string
  startedAt: string
  /** Present when the process was wrapped in `timeout`, which is what makes 124 meaningful. */
  timeoutMs?: number
}

/** GNU `timeout`'s exit code for a command it had to terminate. */
export const TIMEOUT_EXIT_CODE = 124

/**
 * Wrap argv in the shell script that journals it.
 *
 * `setsid --wait` puts the process in a session of its own, which is what makes a group kill
 * reach everything the process spawned rather than only the wrapper. `--wait` rather than a
 * bare `setsid` because `setsid` forks when its caller already leads a process group, and a
 * forked plain `setsid` returns immediately — the journal would then record an exit while
 * the real work was still running.
 *
 * **The wrapper ignores `SIGTERM` and the command does not.** A group kill reaches every
 * member, wrapper included, and a wrapper that died with its child would never reach the line
 * that records the exit — so a perfectly ordinary termination would be indistinguishable from
 * a process that vanished. Ignoring it in the wrapper and clearing the disposition inside the
 * child (ignored signals are otherwise inherited across `fork`) leaves the kill doing exactly
 * what the caller asked while the exit still gets written. `SIGKILL` cannot be trapped, so a
 * `kill -9` still produces the no-exit-record state — correctly, because nothing observed the
 * process finishing.
 */
export function journalledCommand(options: {
  paths: JournalPaths
  command: SandboxCommand
  meta: JournalMeta
  timeout?: number
}): string {
  const { paths, command, meta } = options
  const argv = options.timeout === undefined
    ? quoteArgv(command)
    : `timeout -s TERM ${Math.max(1, Math.ceil(options.timeout / 1000))} ${quoteArgv(command)}`

  const inner = [
    `echo $$ > ${quoteArg(paths.pid)}`,
    'trap \'\' TERM',
    `{ trap - TERM ; exec ${argv} ; } > ${quoteArg(paths.stdout)} 2> ${quoteArg(paths.stderr)} &`,
    'child=$!',
    'wait "$child"',
    `echo $? > ${quoteArg(paths.exit)}`,
  ].join('\n')

  return [
    `mkdir -p ${quoteArg(paths.dir)}`,
    `printf '%s' ${quoteArg(JSON.stringify(meta))} > ${quoteArg(paths.meta)}`,
    `: > ${quoteArg(paths.stdout)}`,
    `: > ${quoteArg(paths.stderr)}`,
    `exec setsid --wait sh -c ${quoteArg(inner)}`,
  ].join('\n')
}

/**
 * Parse the wrapper's exit line.
 *
 * A shell reports a signalled child as `128 + signal`, which is the only signal information
 * `$?` carries, so that is what the signal is recovered from. `timedOut` is left to the
 * caller: the journal cannot tell a `timeout`-sent TERM from any other one.
 */
export function parseExitLine(line: string): { code: number, signal?: number } | undefined {
  const code = Number.parseInt(line.trim(), 10)
  if (!Number.isInteger(code)) {
    return undefined
  }
  return code > 128 && code < 256 ? { code, signal: code - 128 } : { code }
}
