import type {
  SandboxFileContent,
  SandboxFileEncoding,
  SandboxFiles,
  SandboxFileStream,
} from '../contract'
/**
 * File access inside the container.
 *
 * Declared in the contract's Cloudflare-shaped form — positional path, encoding-selected
 * overloads — rather than the AI SDK harness's options-object form. That is deliberate and
 * documented on `SandboxFiles`: keeping the contract assignable from `@cloudflare/sandbox`'s
 * own client is what lets the incumbent backend cost nothing, and the harness's shape is a
 * further translation that `../harness/files.ts` already performs for every backend at once.
 */
import { Buffer } from 'node:buffer'
import { execInContainer, execInContainerBytes, spawnInContainer } from './exec'
import { quoteArg } from './shell-quote'

/** Raised when a read names a path the container does not have. */
export class SandboxFileNotFoundError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`file '${path}' does not exist in the sandbox`)
    this.name = 'SandboxFileNotFoundError'
    this.path = path
  }
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

async function readStream(container: string, path: string): Promise<SandboxFileStream> {
  // Existence is checked first: a streamed read cannot report a missing file through its
  // body, and a caller that got an empty stream would read it as an empty file.
  const probe = await execInContainer(container, ['test', '-f', path])
  if (probe.exitCode !== 0) {
    throw new SandboxFileNotFoundError(path)
  }

  const proc = spawnInContainer(container, ['cat', path])
  return { content: proc.stdout as ReadableStream<Uint8Array> }
}

async function readDecoded(
  container: string,
  path: string,
  encoding: SandboxFileEncoding | undefined,
): Promise<SandboxFileContent> {
  const result = await execInContainerBytes(container, ['cat', path])
  if (result.exitCode !== 0) {
    throw new SandboxFileNotFoundError(path)
  }

  if (encoding === 'base64') {
    return { content: Buffer.from(result.stdout).toString('base64'), encoding: 'base64' }
  }
  return { content: new TextDecoder().decode(result.stdout), encoding: 'utf-8' }
}

function toBytes(content: string, encoding: SandboxFileEncoding | undefined): Uint8Array {
  return encoding === 'base64'
    ? new Uint8Array(Buffer.from(content, 'base64'))
    : new TextEncoder().encode(content)
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function write(
  container: string,
  path: string,
  content: string | ReadableStream<Uint8Array>,
  options?: { encoding?: SandboxFileEncoding },
): Promise<void> {
  const bytes = typeof content === 'string'
    ? toBytes(content, options?.encoding)
    : await collect(content)

  // One `sh -c` creates the parent and writes the body, so a write to a path whose directory
  // does not exist yet succeeds instead of needing the caller to sequence two calls.
  const script = `mkdir -p ${quoteArg(parentDirectory(path))} && cat > ${quoteArg(path)}`
  const result = await execInContainer(container, ['sh', '-c', script], { stdin: bytes })
  if (result.exitCode !== 0) {
    throw new Error(`writing '${path}' failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}

/** The contract's file surface over one container. */
export function createDockerFiles(container: string): SandboxFiles {
  const readFile = ((path: string, options?: { encoding?: SandboxFileEncoding | 'none' }) => (
    options?.encoding === 'none'
      ? readStream(container, path)
      : readDecoded(container, path, options?.encoding)
  )) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: (path, content, options) => write(container, path, content, options),
    mkdir: async (path, options) => {
      const argv = options?.recursive === true ? ['mkdir', '-p', path] : ['mkdir', path]
      const result = await execInContainer(container, argv)
      if (result.exitCode !== 0) {
        throw new Error(
          `creating '${path}' failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        )
      }
    },
  }
}
