/*
 * Vendored from `chatbot-pf/pleaseworks` (`packages/harness-sandbox/src/process.listeners.test.ts`), relicensed from
 * FSL-1.1-MIT to Apache-2.0 by the copyright holder, Passion Factory, Inc.
 *
 * Comments below naming paths such as `apps/cf-orchestrator/…`, `run/run-workflow.ts` or
 * sibling packages refer to that originating codebase, not to this repository. They are kept
 * because they record why each obligation exists.
 */
/**
 * Which listeners `createProcessSurface` leaves on the caller's signal, and which it takes off.
 *
 * Its own file rather than a third block in `process.cleanup.test.ts`, which is full: that
 * suite is at the 500-line ceiling, and this is a different question in any case. Every test
 * there asks what a guard *did* — a kill issued, a subscription released — and can read the
 * answer off the fixture's recorded calls. A listener left behind does nothing at all: on the
 * paths that leak it never fires, because `abort` is one-shot and has already fired. It is
 * only visible in what the signal is still holding, which is what {@link trackListeners}
 * watches — and watches through the runtime's own collection rather than around it, since a
 * signal that dropped a listener itself is not holding one either.
 */
import type { ProcessLogEvent } from '../../../src/sandbox/contract'
import { describe, expect, it } from 'bun:test'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '../../../src/sandbox/contract'
import { createProcessSurface } from '../../../src/sandbox/harness/process'
import { fakeSandboxProvider, FIXTURE_CWD } from './sandbox.fixtures'

/**
 * Which listeners a signal is left carrying, which is a leak nothing else here would notice.
 *
 * Wrapping the instance's own `addEventListener`/`removeEventListener` rather than counting
 * kills, because the two questions are different: a listener that is never removed still never
 * fires — `abort` is one-shot, and on the paths that leak it has already fired — so it costs
 * nothing observable per spawn and everything cumulatively.
 *
 * The wrapper around the callback is what makes `live` mean the runtime rather than this
 * helper's own bookkeeping. `{ once: true }` collection does *not* go through
 * `removeEventListener` — it is internal to the `EventTarget`, measured under Bun 1.3.14: a
 * wrapped `removeEventListener` records zero calls after a once-listener fires, and the
 * listener is genuinely gone (a second `dispatchEvent` does not re-run it). A set built from
 * add-minus-remove therefore keeps reporting a listener the signal no longer holds, which is a
 * green assertion resting on a fixture that mis-models the runtime — coverage that is not
 * there (cubic review, PR #274; its stated mechanism was that `once` calls
 * `removeEventListener`, which it does not, but the conclusion holds for this reason).
 *
 * So the map is keyed by the caller's own function and holds the wrapper actually attached:
 * firing under `once` drops the entry, exactly as the runtime drops the listener, and
 * `removeEventListener(original)` still finds the wrapper to take off. A removal aimed at some
 * other* function still cannot pass as a removal of this one.
 */
function trackListeners(signal: AbortSignal): { added: () => number, live: () => number } {
  const attached = new Map<unknown, EventListener>()
  let added = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type: string, listener: unknown, listenerOptions?: unknown) => {
    added++
    const once = (listenerOptions as AddEventListenerOptions | undefined)?.once === true
    const wrapper: EventListener = (event) => {
      if (once) {
        attached.delete(listener)
      }
      const callback = listener as EventListener
      callback(event)
    }
    attached.set(listener, wrapper)
    add(type, wrapper, listenerOptions as AddEventListenerOptions)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, listener: unknown, listenerOptions?: unknown) => {
    const wrapper = attached.get(listener)
    attached.delete(listener)
    remove(type, wrapper ?? (listener as EventListener), listenerOptions as EventListenerOptions)
  }) as typeof signal.removeEventListener
  return { added: () => added, live: () => attached.size }
}

/**
 * The listener `startProcess` attaches, and the one exit that has to take it off again.
 *
 * The attach is deliberately ahead of the pre-check — that ordering is what closes the window
 * around `exec` — so a refused spawn throws with a listener already on the signal, and
 * `{ once: true }` cannot collect it: `abort` has fired, so it will never fire again. One
 * signal serves a whole turn of spawns, and each dead listener holds the process handle and
 * the closure around it, so they accumulate for as long as the caller holds the signal
 * (gemini review, PR #274).
 */
describe('createProcessSurface abort listeners on the caller signal', () => {
  it('takes its listener back off the signal when it refuses the spawn', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-exec')
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: (command, execOptions) => {
          controller.abort(reason)
          return session.exec(command, execOptions)
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    // Attached first and then removed, rather than never attached: the attach is what closes
    // the `exec` window, and a spawn that stopped attaching would pass a bare `live() === 0`.
    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(0)
  })

  /**
   * And the exit that must *not* remove it, which is the whole point of attaching one: the
   * caller holds a live process, and killing it on a later abort is the listener's only job.
   */
  it('leaves its listener attached for a spawn that succeeded', async () => {
    const controller = new AbortController()
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider()
    const s = createProcessSurface({
      sandbox: provider.session('sbx'),
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })

    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(1)
  })
})

/**
 * The other exit that refuses a spawn: `openLogStream` throws, and `spawn` has no process to
 * hand back either.
 *
 * The pre-check's leak and this one are the same leak — gemini's finding is that a refused
 * spawn leaves its listener behind, and a spawn refused here is a refused spawn. Fixing the
 * one exit and not the other is the asymmetry that produced #273 in the first place.
 *
 * Both shapes are exercised because round 2 split them onto different branches: an abort
 * landing while `logs()` resolves reaches the recheck, and a `logs()` that rejects with no
 * abort in play reaches the `catch`'s awaited-kill branch. Only the second of them *pins* the
 * detach, and the first test below says why in its own comment — measured by deleting the
 * detach, not read off the code.
 */
describe('createProcessSurface abort listeners when the log stream refuses the spawn', () => {
  /**
   * This one does not pin the detach, and saying so is the point of the comment.
   *
   * The abort lands *after* the listener is attached, so the listener fires, and a listener
   * that fires under `{ once: true }` is collected by the runtime itself — `live()` reaches 0
   * whether or not `spawn` detaches. Measured, not assumed: deleting the detach leaves this
   * test green and fails only its sibling below (cubic review, PR #274).
   *
   * What it does establish is still worth having, and is what the assertions say: this exit
   * leaves the signal clean, by whichever route. That is the property the caller has — the
   * detach is one of the two ways of holding it, and a change that broke *both* (attaching
   * without `once`, say, and dropping the detach) fails here and nowhere else.
   */
  it('leaves the signal clean when the abort lands while the log opens', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-logs')
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            logs: () => {
              controller.abort(reason)
              return Promise.resolve(new ReadableStream<ProcessLogEvent>())
            },
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(0)
  })

  /**
   * And the branch with no abort at all, where the listener is even more plainly dead: it was
   * attached for a process that no longer has a caller, and the signal it is on may serve the
   * whole rest of the turn.
   */
  it('takes its listener back off when the log open fails with no abort in play', async () => {
    const controller = new AbortController()
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider({
      script: () => ({ logsRejects: new Error('log stream unavailable') }),
    })
    const s = createProcessSurface({
      sandbox: provider.session('sbx'),
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal }))
      .rejects
      .toThrow('log stream unavailable')
    // Attached as well as removed: the attach is what covers the `exec` window, and a spawn
    // that stopped attaching would pass a bare `live() === 0`.
    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(0)
  })
})

/**
 * And the third state of that listener: taken off once the process is gone, kept while it may
 * still be running. `wait()` is the only place the difference can be read.
 *
 * The two rejection classes are the whole subject here, so both are driven. Detaching on the
 * wrong one is not a leak but its opposite — the guard dropped while there is still something
 * to kill — and a test that only pinned the detach would go green for a `wait()` that detached
 * unconditionally, which is the defect (cubic review, PR #7).
 */
describe('createProcessSurface abort listeners once the process has ended', () => {
  /** Spawn, wait, and report what the caller's signal is still carrying. */
  async function liveAfterWait(waitRejects?: unknown): Promise<number> {
    const controller = new AbortController()
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider({
      script: () => (waitRejects === undefined ? {} : { waitRejects }),
    })
    const s = createProcessSurface({
      sandbox: provider.session('sbx'),
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    const spawned = await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    // Attached and then still attached or not, rather than never attached: a surface that
    // stopped attaching at all would pass every `live() === 0` assertion below for free.
    expect(listeners.added()).toBe(1)
    // `await` inside a `try` rather than `.catch`, because the harness types `wait()` as
    // `PromiseLike`, which carries no `catch` (TS2339) — the same reason {@link bestEffort}
    // exists one file over.
    try {
      await spawned.wait()
    }
    catch {}
    return listeners.live()
  }

  it('takes its listener back off when the process exits', async () => {
    expect(await liveAfterWait()).toBe(0)
  })

  /**
   * The contract's own words for this error are "the process is already gone and recorded no
   * exit", which puts it on the same side of the line as an exit: nothing is left to kill, so
   * the listener is dead weight the caller's signal would carry for the rest of the turn.
   */
  it('takes its listener back off when the wait finds no exit record', async () => {
    expect(await liveAfterWait(new SandboxNoExitRecordError('p1'))).toBe(0)
  })

  /**
   * The other side, and the reason the detach is not unconditional. A timeout means the wait
   * ended and the process did not, so the caller "kills it or waits longer" — and killing it on
   * a later abort is the only thing this listener was ever attached for.
   */
  it('leaves its listener attached when the wait times out', async () => {
    expect(await liveAfterWait(new SandboxWaitTimeoutError('p1', 5000))).toBe(1)
  })

  /**
   * And the fallback branch the contract requires: a rejection that is neither type says
   * nothing about whether the process is still running, so it is treated as the case where it
   * might be.
   */
  it('leaves its listener attached when the wait fails for some other reason', async () => {
    expect(await liveAfterWait(new Error('wait transport reset'))).toBe(1)
  })
})
