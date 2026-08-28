/**
 * The process journal — what a host process forgets when it exits, written to disk.
 *
 * The contract requires a process to outlive the call that started it: `getProcess(id)` and
 * `logs({ replay: true })` are read *after* it exits, and `SandboxProvider.session` is called
 * per use rather than held, so the reader is frequently not the process that spawned the
 * command. An in-memory registry of child handles answers none of that across a restart, so
 * each process is instead wrapped in a shell that redirects both streams to files and records
 * its own exit status beside them — the same shape `../docker/journal.ts` arrived at, for the
 * same reason.
 *
 * stdout and stderr stay in separate files rather than one interleaved log because
 * `ProcessLogEvent` is tagged per stream.
 *
 * **Why a process ended is journalled separately from what it exited with.** `$?` is one
 * integer and every reading of it is ambiguous — `128 + n` is a signalled child but also an
 * ordinary exit code in the 129..255 range — so the wrapper writes a `signal` record and the
 * watchdog writes a `timeout` marker, and the exit code is never asked to carry either fact.
 *
 * Two things differ from the Docker wrapper, and both are portability rather than taste:
 *
 * - **No `setsid`.** macOS ships no such binary. It is not needed here because the wrapper is
 *   spawned with `detached: true`, which makes it a process-group leader in its own right —
 *   which is the property `setsid` was bought for, so a group kill still reaches everything
 *   the command spawned.
 * - **Nothing reads `/proc`.** The Docker escalation walks it to SIGKILL the group's survivors
 *   while sparing itself; there is no `/proc` on macOS. The escalation here writes the exit
 *   record *first* and then kills the whole group, itself included — which needs no process
 *   listing at all, and leaves a reader the same facts.
 *
 * A third difference is not portability: **nothing in the script is string-interpolated.** The
 * journal directory, the timeout and the argv all arrive as positional parameters, so the
 * script is a constant and no quoting function stands between a caller's argv and `execve`.
 * The Docker backend needs `shell-quote.ts` because its wrapper travels as one `sh -c` string
 * through `docker exec`; here the arguments travel beside the script instead of inside it.
 */
import type { SandboxCommand } from '../contract'
import { constants } from 'node:os'
import { join } from 'node:path'

export interface JournalPaths {
  dir: string
  meta: string
  pid: string
  stdout: string
  stderr: string
  exit: string
  /** Number of the signal the wrapper saw reach the group, when one did. */
  signal: string
  /** Touched by the watchdog when the process outran its timeout. Presence is the fact. */
  timeout: string
  /** Written by a caller that gave up before the wrapper launched. Presence cancels it. */
  abandon: string
}

/**
 * Process ids this backend will resolve to a journal directory.
 *
 * `exec()` mints `crypto.randomUUID()`, which fits — but `getProcess(id)` takes whatever a
 * caller passes, and the id becomes a path segment. Without this, `../../../etc` reads a
 * journal outside `journalRoot`, and a `remove()`-shaped id reaches outside the tree this
 * backend owns. `./root.ts` makes the same argument for sandbox ids, where the answer is a
 * lossy sanitiser plus a digest; here rejection is better than repair, because a process id is
 * only ever one this backend handed out.
 */
const JOURNAL_ID = /^[\w-]{1,128}$/

export function isJournalId(value: string): boolean {
  return JOURNAL_ID.test(value)
}

/** The paths one process's journal is made of. */
export function journalPaths(journalRoot: string, processId: string): JournalPaths {
  const dir = join(journalRoot, processId)
  return {
    dir,
    meta: join(dir, 'meta'),
    pid: join(dir, 'pid'),
    stdout: join(dir, 'out'),
    stderr: join(dir, 'err'),
    exit: join(dir, 'exit'),
    signal: join(dir, 'signal'),
    timeout: join(dir, 'timeout'),
    abandon: join(dir, 'abandon'),
  }
}

/** What the journal records so `status()` can answer without the process. */
export interface JournalMeta {
  id: string
  command: SandboxCommand
  cwd?: string
  startedAt: string
  /** Present when the process was wrapped in a timeout watchdog. */
  timeoutMs?: number
}

/**
 * Catchable signals the wrapper survives, with the number a POSIX shell reports for them.
 *
 * The numbers are read from the *host's* own signal table rather than written down, because
 * they are not portable: `SIGUSR1` is 10 on Linux and 30 on macOS, so a literal 10 would be
 * recorded for a process the shell exits with `128 + 30`, {@link reconcileSignal} would find
 * the two disagree, and a signalled process would be reported as having merely returned 158.
 * The wrapper runs on this host, so this host's table is the right one.
 *
 * `SIGKILL` is deliberately absent: it cannot be trapped, so a `kill -9` still produces the
 * no-exit-record state — correctly, because nothing observed the process finishing.
 */
const RECORDED_SIGNALS: ReadonlyArray<readonly [name: string, number: number]>
  = (['HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'TERM'] as const)
    .map(name => [name, constants.signals[`SIG${name}`]] as const)

/**
 * Seconds the escalation waits after a timeout's `SIGTERM` before forcing the group down.
 *
 * A command is free to trap or ignore `SIGTERM`, and one that does would otherwise outlive
 * the timeout it was given.
 */
const KILL_GRACE_SECONDS = '3'

/** Read from the host's table for the reason {@link RECORDED_SIGNALS} gives. */
const SIGTERM = constants.signals.SIGTERM
const SIGKILL = constants.signals.SIGKILL

/** What the journal records for a group SIGKILLed by the escalation: the shell's `128 + 9`. */
const SIGKILL_EXIT_CODE = String(128 + SIGKILL)

const SIGNAL_NAMES = RECORDED_SIGNALS.map(([name]) => name).join(' ')

/**
 * The wrapper, as a constant POSIX shell script.
 *
 * `$1` is the journal directory, `$2` the timeout in seconds (empty for none), and everything
 * after them is the command — so `exec "$@"` runs the caller's argv with no quoting anywhere
 * in the path from `SandboxCommand` to `execve`.
 *
 * **The wrapper records the catchable signals and the command does not.** A group kill reaches
 * every member, wrapper included, and a wrapper that died with its child would never reach the
 * line that writes the exit record — so an ordinary termination would be indistinguishable
 * from a process that vanished. Trapping in the wrapper and clearing those dispositions inside
 * the child (trap settings are otherwise inherited across `fork`) leaves the kill doing exactly
 * what the caller asked while the exit still gets written.
 *
 * A trapped signal interrupts `wait`, which is why the wait is a loop: the shell returns early
 * to run the handler, and the child is still there to be waited on again.
 */
export const WRAPPER_SCRIPT: string = [
  'dir=$1',
  'budget=$2',
  'shift 2',
  // The wrapper leads its own process group, courtesy of the spawn's `detached`. That is what
  // makes `kill -TERM -$wrapper` reach the command's whole tree and not the caller's.
  'wrapper=$$',
  'echo "$wrapper" > "$dir/pid"',
  // A caller whose start never confirmed leaves a marker rather than a kill, because there was
  // no pid to kill yet. Launching anyway would strand the command with nothing able to reap it.
  'if [ -e "$dir/abandon" ] ; then exit 0 ; fi',
  '',
  // Born from the TERM handler rather than started up front, and deliberately: a process
  // created *after* a group signal never receives it, so this survives the SIGTERM it is
  // escalating from without having to ignore it.
  'escalate() {',
  `  sleep ${KILL_GRACE_SECONDS}`,
  // The exit record, not a pid check: a reaped pid can be reused by then, and this file is the
  // journal's own answer to "is it over".
  '  if [ -e "$dir/exit" ] ; then return 0 ; fi',
  `  printf %s ${SIGKILL} > "$dir/signal"`,
  // Written *before* the kill, which is what lets the kill be a plain group kill. The wrapper
  // dies with the group and never reaches its own `echo`, so this line is the exit record.
  `  echo ${SIGKILL_EXIT_CODE} > "$dir/exit"`,
  '  kill -9 "-$wrapper" 2>/dev/null',
  '}',
  '',
  'on_signal() {',
  '  printf %s "$1" > "$dir/signal"',
  `  if [ "$1" = ${SIGTERM} ] && [ -e "$dir/timeout" ] ; then`,
  '    escalate &',
  '    escalator=$!',
  '  fi',
  '}',
  '',
  ...RECORDED_SIGNALS.map(([name, number]) => `trap 'on_signal ${number}' ${name}`),
  '',
  `{ trap - ${SIGNAL_NAMES} ; exec "$@" ; } > "$dir/out" 2> "$dir/err" &`,
  'child=$!',
  '',
  // Records *why* it fired before it fires, so a reader never has to infer a timeout from an
  // exit code, and signals the whole group so grandchildren go with it. It then dies of its
  // own signal; the wrapper's TERM handler is what carries the escalation on from here.
  'if [ -n "$budget" ] ; then',
  // The nap is the watchdog's own child rather than the watchdog itself, so that standing the
  // watchdog down below can take the `sleep` with it. Killing the subshell alone leaves the
  // `sleep` orphaned and running out the whole budget — hours, for the timeout a long turn is
  // given — after the command it was watching has already exited and been reaped.
  '  (',
  //   A subshell inherits the wrapper's trap *actions*, so this replaces `on_signal` for the
  //   watchdog: a TERM here is the wrapper saying the deadline is no longer needed, which is a
  //   different thing from the TERM the watchdog itself sends the group.
  //
  //   **Two traps, because a stand-down can arrive before there is a nap to stand down.** The
  //   wrapper sends its TERM as soon as it has reaped the child, and for a command that
  //   finishes instantly that can land before `nap=$!` has run — leaving a handler that kills
  //   `$nap` with nothing in it, and a `sleep` orphaned for the whole budget. So the first
  //   trap only records that the stand-down happened; it cannot exit, because exiting is what
  //   strands the nap. The second replaces it once the pid is in hand, and the check between
  //   them catches a stand-down that arrived while the first was installed. Every ordering is
  //   covered: before the fork, between the fork and the assignment, and after.
  //
  //   `jobs -p` would look like the shorter answer and is not one: a command substitution runs
  //   in a subshell, which does not inherit the job table, so under `dash` — Debian and Ubuntu's
  //   `/bin/sh` — it expands to nothing and *every* stand-down leaks its nap.
  '    standdown=',
  '    trap \'standdown=1\' TERM',
  '    sleep "$budget" &',
  '    nap=$!',
  '    trap \'kill -9 "$nap" 2>/dev/null ; exit 0\' TERM',
  '    if [ -n "$standdown" ] ; then kill -9 "$nap" 2>/dev/null ; exit 0 ; fi',
  '    wait "$nap"',
  '    : > "$dir/timeout"',
  '    kill -TERM "-$wrapper" 2>/dev/null',
  '  ) &',
  '  watchdog=$!',
  'fi',
  '',
  'wait "$child"',
  'status=$?',
  'while kill -0 "$child" 2>/dev/null ; do',
  '  wait "$child"',
  '  status=$?',
  'done',
  '',
  // TERM rather than KILL, because the watchdog has a disposition for it that also reaps its
  // nap. A KILL here would be delivered to the subshell alone.
  'if [ -n "$watchdog" ] ; then kill -TERM "$watchdog" 2>/dev/null || true ; fi',
  // Best effort only: an escalation that outlives this finds the exit record below and returns
  // without touching anything.
  'if [ -n "$escalator" ] ; then kill -9 "$escalator" 2>/dev/null || true ; fi',
  'echo "$status" > "$dir/exit"',
].join('\n')

/** Seconds, as a literal `sleep` accepts on both GNU and BSD — sub-second budgets included. */
export function timeoutSeconds(timeoutMs: number): string {
  return (Math.max(1, timeoutMs) / 1000).toFixed(3)
}

/**
 * The argv that runs one journalled command.
 *
 * `sh -c <script> sh <args…>` — the second `sh` is `$0`, which a POSIX shell consumes before
 * assigning `$1`, so the journal directory really is `$1`.
 */
export function wrapperArgv(options: {
  paths: JournalPaths
  command: SandboxCommand
  timeout?: number
}): string[] {
  return [
    'sh',
    '-c',
    WRAPPER_SCRIPT,
    'sh',
    options.paths.dir,
    options.timeout === undefined ? '' : timeoutSeconds(options.timeout),
    ...options.command,
  ]
}

/**
 * Parse the wrapper's exit line.
 *
 * Only the code: a shell reports a signalled child as `128 + signal`, but so does a command
 * that simply returned 143, and the journal has a `signal` record for the difference.
 */
export function parseExitLine(line: string): { code: number } | undefined {
  const code = Number.parseInt(line.trim(), 10)
  return Number.isInteger(code) ? { code } : undefined
}

/**
 * The signal the wrapper saw, when the exit code agrees that the child died of it.
 *
 * Both facts are required: the record alone would attribute a signal the wrapper caught to a
 * child that went on to exit normally, and the code alone is what fabricated signals in the
 * first place.
 */
export function reconcileSignal(exitCode: number, recorded: number | undefined): number | undefined {
  return recorded !== undefined && exitCode === 128 + recorded ? recorded : undefined
}
