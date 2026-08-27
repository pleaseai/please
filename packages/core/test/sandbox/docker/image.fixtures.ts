/**
 * The image the docker integration suites run on, and the one-time pull that warms it.
 *
 * A first use on a cold machine makes `docker run` pull the image inline, and that pull is
 * counted against whichever test happened to touch the daemon first — bun allows a test
 * 5000ms by default, and a CI runner with an empty image cache does not finish a pull in
 * that. The run then dies of `SIGTERM` mid-create, and every later test inherits a sandbox
 * whose container was never made.
 *
 * Pulling here instead puts that cost where it belongs: `beforeAll` is setup, it takes an
 * explicit timeout of its own, and the tests only ever exercise a warm cache. Raising the
 * per-test timeout would have hidden the same fragility one notch higher up.
 */
import { runDocker } from '../../../src/sandbox/docker/cli'

/** The image both integration suites run their sandboxes on. */
export const SANDBOX_IMAGE = 'debian:bookworm-slim'

/** Budget for the pull. Generous on purpose: it is a network fetch, not a unit of work. */
export const IMAGE_PULL_TIMEOUT_MS = 180_000

/** Fetch the sandbox image, so nothing after this point pays for a cold cache. */
export async function pullSandboxImage(): Promise<void> {
  const result = await runDocker(['pull', SANDBOX_IMAGE])
  if (result.exitCode !== 0) {
    throw new Error(
      `pulling '${SANDBOX_IMAGE}' failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    )
  }
}
