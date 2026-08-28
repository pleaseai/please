/**
 * `@pleasedev/core/sandbox/docker` — a local container backend for the sandbox contract.
 *
 * **Host-only.** Everything here spawns the `docker` CLI, so this subpath must never be
 * reached from a Cloudflare Worker bundle. It is a separate entry point for exactly that
 * reason: importing `@pleasedev/core` or `@pleasedev/core/sandbox` pulls none of it in.
 */

export { DOCKER_BIN, DockerCommandError, isDockerAvailable } from './cli'
export type { DockerCallOptions, DockerResult } from './cli'

export { containerName, createContainerHandle } from './container'
export type { ContainerHandle, ContainerOptions } from './container'

export { SandboxFileNotFoundError } from './files'

export { JOURNAL_ROOT, journalPaths } from './journal'
export type { JournalMeta, JournalPaths } from './journal'

export { containerEnv, createDockerSandbox, DEFAULT_IMAGE } from './provider'
export type { DockerSandboxOptions } from './provider'

export { createDockerSession } from './session'
export type { DockerSessionOptions } from './session'
