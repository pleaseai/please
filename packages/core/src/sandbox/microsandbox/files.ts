/**
 * File access inside the microVM.
 *
 * Declared in the contract's Cloudflare-shaped form — positional path, encoding-selected
 * overloads — for the reason `SandboxFiles` documents.
 *
 * Reads and writes go through the vendor's own filesystem channel rather than through `cat`, and
 * that is the one place this backend is plainly better off than `../docker`: bytes never pass
 * through a shell, so there is no quoting to get right and nothing that a `-` at the start of a
 * path could be read as. Directory creation still goes through `sh`, because `mkdir -p`'s
 * semantics are exactly specified and the vendor's own `mkdir` does not document whether it
 * creates intermediate directories.
 */
import type { SandboxFileContent, SandboxFileEncoding, SandboxFiles, SandboxFileStream } from '../contract'
import type { MicroSandbox } from './runtime'
import { Buffer } from 'node:buffer'
import { SandboxFileNotFoundError } from '../contract'
import { quoteArg } from '../docker/shell-quote'
import { execScript } from './guest'

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/**
 * A streamed read.
 *
 * The vendor's stream is an async source with a `recv()` that answers `null` at the end, so this
 * is the same pull adaptation `./guest.ts` performs for exec output. Existence is settled before
 * the stream is handed back: a streamed read cannot report a missing file through its body, and a
 * caller that got an empty stream would read it as an empty file.
 */
async function readStream(sandbox: MicroSandbox, path: string): Promise<SandboxFileStream> {
  let source
  try {
    source = await sandbox.fs().readStream(path)
  }
  catch (cause) {
    throw Object.assign(new SandboxFileNotFoundError(path), { cause })
  }

  return {
    content: new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = await source.recv()
        if (chunk === null) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    }),
  }
}

async function readDecoded(
  sandbox: MicroSandbox,
  path: string,
  encoding: SandboxFileEncoding | undefined,
): Promise<SandboxFileContent> {
  let bytes: Uint8Array
  try {
    bytes = await sandbox.fs().read(path)
  }
  catch (cause) {
    // The vendor reports a missing path by throwing, and it is the only failure a read of an
    // existing sandbox has — but it is not the only one it *could* have, so the cause is kept
    // rather than swallowed.
    throw Object.assign(new SandboxFileNotFoundError(path), { cause })
  }

  if (encoding === 'base64') {
    return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
  }
  return { content: new TextDecoder().decode(bytes), encoding: 'utf-8' }
}

function toBytes(content: string, encoding: SandboxFileEncoding | undefined): Uint8Array {
  return encoding === 'base64'
    ? new Uint8Array(Buffer.from(content, 'base64'))
    : new TextEncoder().encode(content)
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** `mkdir -p`, spelled once for both the explicit call and the implicit one a write needs. */
async function makeDirectory(
  sandbox: MicroSandbox,
  path: string,
  recursive: boolean,
): Promise<void> {
  const flag = recursive ? '-p ' : ''
  const result = await execScript(sandbox, `mkdir ${flag}-- ${quoteArg(path)}`)
  if (result.exitCode !== 0) {
    throw new Error(`creating '${path}' failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}

/**
 * Write bytes, creating the parent directory only if the write says it is missing.
 *
 * The retry rather than an unconditional `mkdir -p` keeps the common case — a write into a
 * directory that already exists — at a single call, which is the same shape flue's local sandbox
 * settled on and the reason `../local/files.ts` does it too.
 */
async function write(
  sandbox: MicroSandbox,
  path: string,
  content: string | ReadableStream<Uint8Array>,
  options?: { encoding?: SandboxFileEncoding },
): Promise<void> {
  const bytes = typeof content === 'string'
    ? toBytes(content, options?.encoding)
    : await collect(content)

  try {
    await sandbox.fs().write(path, bytes)
  }
  catch {
    await makeDirectory(sandbox, parentDirectory(path), true)
    await sandbox.fs().write(path, bytes)
  }
}

/** The contract's file surface over one microVM. */
export function createMicrosandboxFiles(sandbox: MicroSandbox): SandboxFiles {
  const readFile = ((path: string, options?: { encoding?: SandboxFileEncoding | 'none' }) => (
    options?.encoding === 'none'
      ? readStream(sandbox, path)
      : readDecoded(sandbox, path, options?.encoding)
  )) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: (path, content, options) => write(sandbox, path, content, options),
    mkdir: (path, options) => makeDirectory(sandbox, path, options?.recursive ?? false),
  }
}
