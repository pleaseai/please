/**
 * The `docker` command line, wrapped.
 *
 * Driven through the CLI rather than the daemon's HTTP API on purpose: any
 * docker-compatible runtime reachable as a `docker` binary then works unchanged — Docker
 * Desktop, OrbStack, Colima, Podman's docker shim — and there is no socket path to discover
 * or a daemon client library to keep in step with the runtime. eve's docker backend makes
 * the same trade for the same reason.
 */

import process from 'node:process'

/** Binary every call goes through. Point this at a compatible CLI to swap runtimes. */
export const DOCKER_BIN = process.env.PLEASE_DOCKER_PATH ?? 'docker'

export interface DockerResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface DockerCallOptions {
  stdin?: Uint8Array
  abortSignal?: AbortSignal
}

function spawnDocker(args: readonly string[], options: DockerCallOptions) {
  return Bun.spawn([DOCKER_BIN, ...args], {
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.abortSignal,
  })
}

async function writeStdin(
  proc: ReturnType<typeof spawnDocker>,
  stdin: Uint8Array | undefined,
): Promise<void> {
  if (stdin === undefined) {
    return
  }
  // `stdin` is only a writable sink when the spawn asked for one, and its type covers every
  // other mode the option can take — so the narrowing is real, not defensive noise.
  const sink = proc.stdin
  if (sink == null || typeof sink === 'number') {
    return
  }
  sink.write(stdin)
  await sink.end()
}

/** Run a docker subcommand to completion, collecting both streams as text. */
export async function runDocker(
  args: readonly string[],
  options: DockerCallOptions = {},
): Promise<DockerResult> {
  const proc = spawnDocker(args, options)
  // Both readers are started before stdin is written: a child that fills its stdout pipe
  // blocks until someone drains it, and a parent still writing stdin never would.
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()

  const [, out, err, exitCode] = await Promise.all([
    writeStdin(proc, options.stdin),
    stdout,
    stderr,
    proc.exited,
  ])

  return { exitCode, stdout: out, stderr: err }
}

/** As {@link runDocker}, but keeps stdout as bytes — for files that are not valid UTF-8. */
export async function runDockerBytes(
  args: readonly string[],
  options: DockerCallOptions = {},
): Promise<{ exitCode: number, stdout: Uint8Array, stderr: string }> {
  const proc = spawnDocker(args, options)
  const stdout = new Response(proc.stdout).bytes()
  const stderr = new Response(proc.stderr).text()

  const [, out, err, exitCode] = await Promise.all([
    writeStdin(proc, options.stdin),
    stdout,
    stderr,
    proc.exited,
  ])

  return { exitCode, stdout: out, stderr: err }
}

/** Flags whose argument carries a value the caller may consider secret. */
const SECRET_VALUE_FLAGS = new Set(['--env', '-e', '--build-arg', '--env-file', '--secret'])

/** What replaces a redacted value, so the shape of the argv is still readable. */
const REDACTED = '<redacted>'

/**
 * Blank out the value half of every secret-bearing argument.
 *
 * Container creation passes the sandbox's environment as `--env KEY=value`, so an argv
 * reproduced verbatim in an error message puts API keys into logs and stack traces. The key
 * half is kept — it is what makes a failure diagnosable — and only the value is dropped.
 */
export function redactArgs(args: readonly string[]): string[] {
  const redactValue = (arg: string) => {
    const separator = arg.indexOf('=')
    return separator < 0 ? REDACTED : `${arg.slice(0, separator + 1)}${REDACTED}`
  }

  const out: string[] = []
  let pendingSecret = false
  for (const arg of args) {
    const inlineFlag = arg.slice(0, Math.max(0, arg.indexOf('=')))
    if (pendingSecret) {
      out.push(redactValue(arg))
      pendingSecret = false
    }
    else if (SECRET_VALUE_FLAGS.has(arg)) {
      out.push(arg)
      pendingSecret = true
    }
    else if (SECRET_VALUE_FLAGS.has(inlineFlag)) {
      // The `--env=KEY=value` spelling: keep the flag and the key, drop the value.
      out.push(`${inlineFlag}=${redactValue(arg.slice(inlineFlag.length + 1))}`)
    }
    else {
      out.push(arg)
    }
  }
  return out
}

/** The error every non-zero docker invocation surfaces, so callers can match on one type. */
export class DockerCommandError extends Error {
  /** The argv, with every secret-shaped value redacted — this object reaches logs. */
  readonly args: readonly string[]
  readonly exitCode: number
  readonly stderr: string

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    const safe = redactArgs(args)
    super(`docker ${safe.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
    this.name = 'DockerCommandError'
    this.args = safe
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** Run a docker subcommand, returning stdout and throwing unless it exited 0. */
export async function runDockerOrThrow(
  args: readonly string[],
  options: DockerCallOptions = {},
): Promise<string> {
  const result = await runDocker(args, options)
  if (result.exitCode !== 0) {
    throw new DockerCommandError(args, result.exitCode, result.stderr)
  }
  return result.stdout
}

/** Whether a Linux-container docker daemon is reachable right now. */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await runDocker(['version', '--format', '{{.Server.Os}}'])
    return result.exitCode === 0 && result.stdout.trim() === 'linux'
  }
  catch {
    return false
  }
}
