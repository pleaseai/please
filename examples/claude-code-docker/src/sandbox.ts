/**
 * Where this agent runs: a container on the local Docker daemon.
 *
 * Singular `sandbox.ts` rather than a `sandboxes/` directory because there is one of them.
 * The backend a deployment uses is the entrypoint's business — a `cloudflare.ts` beside this
 * file would build the same definition over a different backend — not a folder of alternatives.
 */
import process from 'node:process'
import { defineSandbox } from '@pleaseai/core/sandbox'
import { DEFAULT_IMAGE, docker } from '@pleaseai/core/sandbox/docker'

export default defineSandbox({
  backend: docker({ image: process.env.EXAMPLE_IMAGE ?? DEFAULT_IMAGE }),

  // `node:22-bookworm` ships pnpm only through corepack, and the Claude Code adapter's first
  // act inside the container is `pnpm install`. Neither AI SDK hook runs early enough to help,
  // which is what `onCreate` exists for. A purpose-built image would carry pnpm and delete this.
  onCreate: async ({ session }) => {
    const proc = await session.exec(['sh', '-c', 'corepack enable pnpm'])
    const exit = await proc.waitForExit()
    if (exit.code !== 0) {
      throw new Error(`corepack enable pnpm failed in the sandbox (exit ${exit.code})`)
    }
  },
})
