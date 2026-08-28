/**
 * File access inside the virtual filesystem.
 *
 * Declared in the contract's Cloudflare-shaped form — positional path, encoding-selected
 * overloads — for the reason `SandboxFiles` documents. The vendor's own surface is close enough
 * that this is mostly renaming: `writeFiles` takes a map, `readFile` takes the encoding
 * positionally, and `mkDir` is spelled with a capital D.
 *
 * Unlike `../local`, the paths here reach nothing outside the sandbox: the filesystem is the
 * interpreter's own, so a path that climbs out with `..` climbs out of a virtual root. That is
 * the one dimension in which this backend is stronger than the local one.
 *
 * **This filesystem stores text, not bytes.** A write is decoded as UTF-8 before it is stored,
 * so a byte sequence that is not valid UTF-8 comes back as replacement characters — measured:
 * four bytes `00 FF FE 01` written as base64 read back as eight, and `wc -c` inside the sandbox
 * agreed with the corrupted length. Base64 is therefore a *transport* encoding here and not a
 * binary capability, and {@link JustBashBinaryUnsupportedError} refuses the write rather than
 * letting a caller discover the corruption later.
 */
import type { SandboxFileContent, SandboxFileEncoding, SandboxFiles, SandboxFileStream } from '../contract'
import type { JustBashHandle } from './sandbox'
import { Buffer } from 'node:buffer'
import { SandboxFileNotFoundError } from '../contract'

/** Raised for a write this filesystem would have to corrupt in order to store. */
export class JustBashBinaryUnsupportedError extends Error {
  readonly path: string
  constructor(path: string, cause: unknown) {
    super(
      `'${path}' is not valid UTF-8. The just-bash filesystem stores text, so these bytes `
      + 'cannot be written without corruption — use the docker or local backend for binary files.',
    )
    this.name = 'JustBashBinaryUnsupportedError'
    this.path = path
    this.cause = cause
  }
}

/**
 * Reject base64 the filesystem could not store faithfully.
 *
 * The check is the same decode the vendor performs, run in `fatal` mode so it throws where the
 * vendor's substitutes a replacement character.
 */
function assertStorable(path: string, base64: string): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(base64, 'base64'))
  }
  catch (cause) {
    throw new JustBashBinaryUnsupportedError(path, cause)
  }
}

/** Resolve a relative path against the sandbox's working directory, POSIX-style. */
export function resolveVirtualPath(cwd: string, path: string): string {
  return path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
}

async function read(
  handle: JustBashHandle,
  path: string,
  encoding: SandboxFileEncoding | undefined,
): Promise<SandboxFileContent> {
  const sandbox = await handle.ready()
  const resolved = resolveVirtualPath(handle.cwd, path)
  const wanted = encoding === 'base64' ? 'base64' : 'utf-8'
  try {
    return { content: await sandbox.readFile(resolved, wanted), encoding: wanted }
  }
  catch (cause) {
    // The vendor reports a missing path by throwing, and it is the only failure `readFile` has
    // — but it is not the only one it *could* have, so the cause is kept rather than swallowed.
    throw Object.assign(new SandboxFileNotFoundError(path), { cause })
  }
}

/**
 * A streamed read, as one chunk.
 *
 * `readFile` hands back a fully materialised string, so there is nothing to stream from — the
 * whole file is in memory before the stream exists. It is offered anyway because the contract's
 * `encoding: 'none'` overload selects it, and a caller written against that overload should not
 * have to know which backend it is talking to.
 */
async function readStream(handle: JustBashHandle, path: string): Promise<SandboxFileStream> {
  const decoded = await read(handle, path, 'base64')
  const bytes = new Uint8Array(Buffer.from(decoded.content, 'base64'))
  return {
    content: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return Buffer.from(bytes).toString('base64')
}

export function createJustBashFiles(handle: JustBashHandle): SandboxFiles {
  const readFile = ((path: string, options?: { encoding?: SandboxFileEncoding | 'none' }) => (
    options?.encoding === 'none'
      ? readStream(handle, path)
      : read(handle, path, options?.encoding)
  )) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: async (path, content, options) => {
      const sandbox = await handle.ready()
      // A stream is collected as base64 rather than decoded as text, so the bytes reach the
      // storability check unchanged rather than being quietly mangled on the way to it.
      const body = typeof content === 'string'
        ? { content, encoding: (options?.encoding === 'base64' ? 'base64' : 'utf-8') as 'utf-8' | 'base64' }
        : { content: await collect(content), encoding: 'base64' as const }
      if (body.encoding === 'base64') {
        assertStorable(path, body.content)
      }
      await sandbox.writeFiles({ [resolveVirtualPath(handle.cwd, path)]: body })
    },
    mkdir: async (path, options) => {
      const sandbox = await handle.ready()
      await sandbox.mkDir(resolveVirtualPath(handle.cwd, path), {
        recursive: options?.recursive ?? false,
      })
    },
  }
}
