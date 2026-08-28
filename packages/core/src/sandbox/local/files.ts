/**
 * File access inside a local sandbox.
 *
 * Declared in the contract's Cloudflare-shaped form — positional path, encoding-selected
 * overloads — rather than the AI SDK harness's options-object form, for the reason
 * `SandboxFiles` documents: keeping the contract assignable from `@cloudflare/sandbox`'s own
 * client is what lets the incumbent backend cost nothing, and the harness's shape is a further
 * translation that `../harness/files.ts` already performs for every backend at once.
 *
 * **Paths are resolved, not confined.** A relative path resolves against the sandbox's working
 * directory; an absolute path is used as given, and so is a relative one that climbs out with
 * `..`. That is not an oversight to be fixed with a prefix check — it is the honest shape of
 * this backend. `exec` runs real host processes with the caller's own uid, so a command can
 * read anything the user can read no matter what this file does, and a guard here would buy a
 * feeling of containment rather than containment. Isolation is what the Docker backend is for.
 */
import type {
  SandboxFileContent,
  SandboxFileEncoding,
  SandboxFiles,
  SandboxFileStream,
} from '../contract'
import { Buffer } from 'node:buffer'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { SandboxFileNotFoundError } from '../contract'

function toBytes(content: string, encoding: SandboxFileEncoding | undefined): Uint8Array {
  return encoding === 'base64'
    ? new Uint8Array(Buffer.from(content, 'base64'))
    : new TextEncoder().encode(content)
}

async function readStream(path: string): Promise<SandboxFileStream> {
  // Existence is checked first: a streamed read cannot report a missing file through its body,
  // and a caller handed an empty stream would read it as an empty file.
  if (!await isFile(path)) {
    throw new SandboxFileNotFoundError(path)
  }
  return { content: Bun.file(path).stream() }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  }
  catch {
    return false
  }
}

async function readDecoded(
  path: string,
  encoding: SandboxFileEncoding | undefined,
): Promise<SandboxFileContent> {
  if (!await isFile(path)) {
    throw new SandboxFileNotFoundError(path)
  }
  const bytes = await Bun.file(path).bytes()

  if (encoding === 'base64') {
    return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
  }
  return { content: new TextDecoder().decode(bytes), encoding: 'utf-8' }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function write(
  path: string,
  content: string | ReadableStream<Uint8Array>,
  options?: { encoding?: SandboxFileEncoding },
): Promise<void> {
  const bytes = typeof content === 'string'
    ? toBytes(content, options?.encoding)
    : await collect(content)

  // The parent is created first, so a write to a path whose directory does not exist yet
  // succeeds instead of needing the caller to sequence two calls — which is what the Docker
  // backend's single `mkdir -p … && cat >` does, in the form the host offers.
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, bytes)
}

export interface LocalFilesOptions {
  /** What a relative path resolves against. */
  workDir: string
}

/** The contract's file surface over one sandbox directory. */
export function createLocalFiles(options: LocalFilesOptions): SandboxFiles {
  const resolvePath = (path: string): string =>
    isAbsolute(path) ? path : resolve(options.workDir, path)

  const readFile = ((path: string, fileOptions?: { encoding?: SandboxFileEncoding | 'none' }) => (
    fileOptions?.encoding === 'none'
      ? readStream(resolvePath(path))
      : readDecoded(resolvePath(path), fileOptions?.encoding)
  )) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: (path, content, fileOptions) => write(resolvePath(path), content, fileOptions),
    mkdir: async (path, fileOptions) => {
      await mkdir(resolvePath(path), { recursive: fileOptions?.recursive ?? false })
    },
  }
}
