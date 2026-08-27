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
 *
 * **Why a process ended is journalled separately from what it exited with.** `$?` is one
 * integer, and every reading of it is ambiguous: `124` is GNU `timeout`'s code but also one
 * a command may return by itself, and `128 + n` is a signalled child but also an ordinary
 * exit code in the 129..255 range. So the wrapper writes two more records — a `signal` file
 * naming the signal that actually reached the process group, and a `timeout` marker touched
 * by the watchdog when it fires — and the exit code is never asked to carry either fact.
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
  /** Number of the signal the wrapper saw reach the group, when one did. */
  signal: string
  /** Touched by the watchdog when the process outran its timeout. Presence is the fact. */
  timeout: string
  /** Written by a caller that gave up before the wrapper launched. Presence cancels it. */
  abandon: string
}

/** The paths one process's journal is made of. */
export function journalPaths(processId: string, root: string = JOURNAL_ROOT): JournalPaths {
  const dir = `${root}/${processId}`
  return {
    dir,
    meta: `${dir}/meta`,
    pid: `${dir}/pid`,
    stdout: `${dir}/out`,
    stderr: `${dir}/err`,
    exit: `${dir}/exit`,
    signal: `${dir}/signal`,
    timeout: `${dir}/timeout`,
    abandon: `${dir}/abandon`,
  }
}

/** What {@link journalledCommand} records so `status()` can answer without the process. */
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
 * `SIGKILL` is deliberately absent: it cannot be trapped, so a `kill -9` still produces the
 * no-exit-record state — correctly, because nothing observed the process finishing.
 */
const RECORDED_SIGNALS: ReadonlyArray<readonly [name: string, number: number]> = [
  ['HUP', 1],
  ['INT', 2],
  ['QUIT', 3],
  ['USR1', 10],
  ['USR2', 12],
  ['TERM', 15],
]

/**
 * Seconds the watchdog waits between its `SIGTERM` and the `SIGKILL` that follows it.
 *
 * A command is free to trap or ignore `SIGTERM`, and one that does would otherwise outlive
 * the timeout it was given — the wrapper's wait loop would keep waiting forever. GNU
 * `timeout -k` is what used to supply this; running our own watchdog means supplying it here.
 */
const KILL_GRACE_SECONDS = '3'

/** Seconds, as a shell literal GNU `sleep` accepts — sub-second timeouts included. */
function timeoutSeconds(timeoutMs: number): string {
  return (Math.max(1, timeoutMs) / 1000).toFixed(3)
}

/** The traps that keep the wrapper alive long enough to journal what happened. */
function trapLines(): string[] {
  return RECORDED_SIGNALS.map(([name, number]) => `trap 'on_signal ${number}' ${name}`)
}

/**
 * The escalation that forces down a command which ignores `SIGTERM`.
 *
 * It is spawned from the wrapper's own `TERM` handler rather than started up front, and that
 * placement is the whole trick: a process created *after* a group signal never receives it,
 * so this survives the `SIGTERM` it is escalating from without having to ignore it. A
 * long-lived process that ignores `TERM` inside the exec's session instead makes the daemon
 * stall every concurrent `docker exec` by two seconds, measured — so "born late" is not just
 * tidier than `trap '' TERM`, it is the version that does not tax every other call.
 *
 * The `SIGKILL` goes to each process individually rather than to the group, because the
 * wrapper is a member of that group and must live to write the exit record. So the group's
 * remaining members are read out of `/proc`, skipping the two that have to survive: the
 * wrapper, and this escalation itself.
 */
function escalateFunction(paths: JournalPaths): string[] {
  return [
    'escalate() {',
    `  sleep ${KILL_GRACE_SECONDS}`,
    // The exit record, not a pid check: a reaped pid can be reused by then, and this file is
    // the journal's own answer to "is it over".
    `  if [ -e ${quoteArg(paths.exit)} ] ; then return 0 ; fi`,
    `  printf '%s' 9 > ${quoteArg(paths.signal)}`,
    '  read self rest < /proc/self/stat',
    '  for entry in /proc/[0-9]* ; do',
    // eslint-disable-next-line no-template-curly-in-string -- shell parameter expansion
    '    victim=${entry#/proc/}',
    '    if [ "$victim" != "$wrapper" ] && [ "$victim" != "$self" ] ; then',
    '      group=$(sed \'s/.*) //\' "$entry/stat" 2>/dev/null | cut -d\' \' -f3)',
    '      if [ "$group" = "$wrapper" ] ; then kill -9 "$victim" 2>/dev/null ; fi',
    '    fi',
    '  done',
    '}',
  ]
}

/** Record the signal that reached the group, and start the escalation when a timeout sent it. */
function signalFunction(paths: JournalPaths): string[] {
  return [
    'on_signal() {',
    `  printf '%s' "$1" > ${quoteArg(paths.signal)}`,
    `  if [ "$1" = 15 ] && [ -e ${quoteArg(paths.timeout)} ] ; then`,
    '    escalate &',
    '    escalator=$!',
    '  fi',
    '}',
  ]
}

/**
 * The timeout watchdog, as shell lines.
 *
 * It records *why* it fired before it fires, so a reader never has to infer a timeout from
 * an exit code, and it signals the whole group so grandchildren go with it. It then dies of
 * its own signal, which is deliberate: the wrapper's `TERM` handler is what carries the
 * escalation on from here.
 */
function watchdogLines(timeout: number, paths: JournalPaths): string[] {
  return [
    `( sleep ${timeoutSeconds(timeout)} ; : > ${quoteArg(paths.timeout)} ; `
    + 'kill -TERM "-$wrapper" 2>/dev/null ) &',
    'watchdog=$!',
  ]
}

/**
 * Wrap argv in the shell script that journals it.
 *
 * `setsid --wait` puts the process in a session of its own, which is what makes a group kill
 * reach everything the process spawned rather than only the wrapper. `--wait` rather than a
 * bare `setsid` because `setsid` forks when its caller already leads a process group, and a
 * forked plain `setsid` returns immediately — the journal would then record an exit while
 * the real work was still running.
 *
 * **The wrapper records the catchable signals and the command does not.** A group kill
 * reaches every member, wrapper included, and a wrapper that died with its child would never
 * reach the line that records the exit — so a perfectly ordinary termination would be
 * indistinguishable from a process that vanished. Trapping them in the wrapper and clearing
 * those dispositions inside the child (trap settings are otherwise inherited across `fork`)
 * leaves the kill doing exactly what the caller asked while the exit still gets written.
 *
 * A trapped signal interrupts `wait`, which is why the wait is a loop: the shell returns
 * early to run the handler, and the child is still there to be waited on again.
 */
export function journalledCommand(options: {
  paths: JournalPaths
  command: SandboxCommand
  meta: JournalMeta
  timeout?: number
}): string {
  const { paths, command, meta } = options
  const names = RECORDED_SIGNALS.map(([name]) => name).join(' ')

  const watchdog = options.timeout === undefined ? [] : watchdogLines(options.timeout, paths)

  const inner = [
    'wrapper=$$',
    `echo $$ > ${quoteArg(paths.pid)}`,
    // A caller whose `exec` timed out before this point leaves a marker instead of a kill,
    // because there is no pid yet to kill. Launching anyway would strand the command.
    `if [ -e ${quoteArg(paths.abandon)} ] ; then exit 0 ; fi`,
    ...escalateFunction(paths),
    ...signalFunction(paths),
    ...trapLines(),
    `{ trap - ${names} ; exec ${quoteArgv(command)} ; } `
    + `> ${quoteArg(paths.stdout)} 2> ${quoteArg(paths.stderr)} &`,
    'child=$!',
    ...watchdog,
    'wait "$child"',
    'status=$?',
    'while kill -0 "$child" 2>/dev/null ; do',
    '  wait "$child"',
    '  status=$?',
    'done',
    ...(options.timeout === undefined ? [] : ['kill -9 "$watchdog" 2>/dev/null || true']),
    // Best effort only: an escalation that outlives this finds the exit record below and
    // returns without touching anything.
    'if [ -n "$escalator" ] ; then kill -9 "$escalator" 2>/dev/null || true ; fi',
    `echo "$status" > ${quoteArg(paths.exit)}`,
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
