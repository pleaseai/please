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
  await writeStdin(proc, options.stdin)

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

/** As {@link runDocker}, but keeps stdout as bytes — for files that are not valid UTF-8. */
export async function runDockerBytes(
  args: readonly string[],
  options: DockerCallOptions = {},
): Promise<{ exitCode: number, stdout: Uint8Array, stderr: string }> {
  const proc = spawnDocker(args, options)
  await writeStdin(proc, options.stdin)

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

/** The error every non-zero docker invocation surfaces, so callers can match on one type. */
export class DockerCommandError extends Error {
  readonly args: readonly string[]
  readonly exitCode: number
  readonly stderr: string

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`docker ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
    this.name = 'DockerCommandError'
    this.args = args
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
