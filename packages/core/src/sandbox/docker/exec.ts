import type { DockerResult } from './cli'
/**
 * Running commands inside an already-created container.
 *
 * Everything here takes argv, never a shell string. `docker exec` hands argv straight to
 * `execve`, so a command built this way needs no quoting and cannot be reinterpreted by a
 * shell that was never involved.
 */
import { DOCKER_BIN, runDocker, runDockerBytes } from './cli'

export interface ExecOptions {
  cwd?: string
  env?: Readonly<Record<string, string>>
  user?: string
  detach?: boolean
  stdin?: Uint8Array
  abortSignal?: AbortSignal
}

function execArgs(container: string, argv: readonly string[], options: ExecOptions): string[] {
  const args = ['exec']
  if (options.stdin !== undefined) {
    args.push('--interactive')
  }
  if (options.detach === true) {
    args.push('--detach')
  }
  if (options.cwd !== undefined) {
    args.push('--workdir', options.cwd)
  }
  if (options.user !== undefined) {
    args.push('--user', options.user)
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`)
  }
  args.push(container, ...argv)
  return args
}

/** Run argv in the container and collect its output as text. */
export function execInContainer(
  container: string,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<DockerResult> {
  return runDocker(execArgs(container, argv, options), {
    stdin: options.stdin,
    abortSignal: options.abortSignal,
  })
}

/** Run argv in the container and collect its stdout as bytes. */
export function execInContainerBytes(
  container: string,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<{ exitCode: number, stdout: Uint8Array, stderr: string }> {
  return runDockerBytes(execArgs(container, argv, options), {
    stdin: options.stdin,
    abortSignal: options.abortSignal,
  })
}

/**
 * Start argv in the container without waiting for it, exposing its live streams.
 *
 * Used for reads that follow a file: the caller consumes `stdout` as it arrives and kills
 * the process when it stops caring.
 */
export function spawnInContainer(
  container: string,
  argv: readonly string[],
  options: ExecOptions = {},
) {
  return Bun.spawn([DOCKER_BIN, ...execArgs(container, argv, options)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** Run a `sh -c` script in the container. Prefer argv; this is for the journal wrapper. */
export function execScript(
  container: string,
  script: string,
  options: ExecOptions = {},
): Promise<DockerResult> {
  return execInContainer(container, ['sh', '-c', script], options)
}
