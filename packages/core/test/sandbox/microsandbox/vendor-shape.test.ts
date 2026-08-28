/**
 * The structural copies in `../../../src/sandbox/microsandbox/runtime.ts`, checked against the
 * vendor's own declarations.
 *
 * This is the part of the backend that **is** verifiable on every host, including one with no
 * native addon: types come from the package's `.d.ts` files and need nothing to load. It is also
 * the part most likely to rot, because the copies exist precisely so that `microsandbox` stays
 * out of this package's public `.d.ts` — nothing else would notice the day the vendor renames a
 * method.
 *
 * The assertions are type aliases, not values: {@link AssignableTo} does its checking in a
 * constraint, so nothing here exists at run time and the file cannot fail for a reason other than
 * the one it is about. Their direction is the one that matters — a **vendor** type must satisfy
 * the **copy**, because that is what the backend does with the objects it is handed. The reverse
 * would be a stronger claim than the copies make; they are deliberately a subset.
 *
 * `bun test` runs this for its one runtime assertion; `tsc` is what actually checks it.
 */
import type {
  ExecEvent,
  ExecHandle,
  ExecOptionsBuilder,
  ExecOutput,
  Sandbox,
  SandboxBuilder,
  SandboxFsOps,
  SandboxHandle,
} from 'microsandbox'
import type {
  MicroExecEvent,
  MicroExecHandle,
  MicroExecOutput,
  MicroFsOps,
  MicroSandbox,
  MicroSandboxBuilder,
  MicroSandboxHandle,
} from '../../../src/sandbox/microsandbox'
import { describe, expect, it } from 'bun:test'
import { isMicrosandboxAvailable } from '../../../src/sandbox/microsandbox'

/** Resolves to `From`, and fails to compile at all unless `From` is assignable to `To`. */
type AssignableTo<From extends To, To> = From

/**
 * The vendor's own exec-options builder.
 *
 * The three types that hand a builder to a `configure` callback are instantiated with it — that
 * type parameter is the whole reason `MicroExecOptionsBuilder` can stay a subset. See the note on
 * it in `../../../src/sandbox/microsandbox/runtime.ts`.
 */
type VendorExecBuilder = InstanceType<typeof ExecOptionsBuilder>

export type EventMatches = AssignableTo<ExecEvent, MicroExecEvent>
export type OutputMatches = AssignableTo<ExecOutput, MicroExecOutput>
export type ExecHandleMatches = AssignableTo<ExecHandle, MicroExecHandle>
export type FsMatches = AssignableTo<SandboxFsOps, MicroFsOps>
export type SandboxMatches = AssignableTo<Sandbox, MicroSandbox<VendorExecBuilder>>
export type BuilderMatches = AssignableTo<SandboxBuilder, MicroSandboxBuilder<VendorExecBuilder>>
export type HandleMatches = AssignableTo<SandboxHandle, MicroSandboxHandle<VendorExecBuilder>>

describe('microsandbox vendor shape', () => {
  it('answers whether this host can load the runtime at all, without throwing', async () => {
    // The suite gate in `./backend.test.ts` depends on this never rejecting: a host with no
    // native addon must get `false`, not the vendor's own load error.
    expect(typeof await isMicrosandboxAvailable()).toBe('boolean')
  })
})
