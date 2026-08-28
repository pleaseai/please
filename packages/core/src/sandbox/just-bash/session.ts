/**
 * One virtual sandbox, as the contract's {@link SandboxSession}.
 *
 * The process registry is a `Map` rather than anything on disk, and that is not a shortcut — see
 * `./sandbox.ts` for why a backend whose filesystem is a heap object has nothing to resume from.
 * It is held by the *provider* and handed in here, so `getProcess` and `listProcesses` answer for
 * the life of that provider rather than for the life of one session object.
 */
import type {
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '../contract'
import type { ProcessRecord } from './process'
import type { JustBashHandle } from './sandbox'
import { envArgv } from './env'
import { createJustBashFiles, resolveVirtualPath } from './files'
import { createProcessHandle, toProcessStatus } from './process'

/**
 * Start one command.
 *
 * `detached: true` is not optional here: the undetached overload resolves only once the command
 * has finished, and the contract's `exec` hands back a handle to a process that is still
 * running. The vendor's own timeout lives on the sandbox rather than the command, so a per-exec
 * budget is expressed with an `AbortSignal` this file owns — which is also what makes
 * `timedOut` answerable, since the vendor reports every cancellation as the same exit code.
 *
 * `options.env` likewise cannot be passed through: the vendor accepts the field and ignores it,
 * so `./env.ts` turns it into a wrapper in front of the command. The record keeps the caller's
 * own argv, not the wrapped one — the wrapper is this backend's business, and `status()` should
 * report the command that was asked for.
 */
async function exec(
  handle: JustBashHandle,
  processes: Map<string, ProcessRecord>,
  argv: SandboxCommand,
  options: SandboxExecOptions = {},
): Promise<SandboxProcessHandle> {
  const sandbox = await handle.ready()
  const [executable, ...args] = envArgv(argv, options.env)

  const controller = new AbortController()
  let expired = false

  const command = await sandbox.runCommand({
    cmd: executable,
    args,
    detached: true,
    signal: controller.signal,
    ...(options.cwd === undefined ? {} : { cwd: resolveVirtualPath(handle.cwd, options.cwd) }),
  })

  // Armed after the command exists, and gated on its exit code, because the timer is what
  // `timedOut` is read from: nothing else stands it down. `settle()` clears it, but only a caller
  // that awaits `waitForExit` reaches that — a caller that merely asks `status()` or `logs()` does
  // not, so a timer left to fire over a command that already exited on its own would report a
  // finished, zero-exit process as having been killed by its own budget.
  const timer = options.timeout === undefined
    ? undefined
    : setTimeout(() => {
        if (command.exitCode !== undefined) {
          return
        }
        expired = true
        controller.abort()
      }, options.timeout)
  // Unreferenced, so a pending budget is not a reason for the host process to stay alive.
  // `settle()` clears the timer, but only a caller that awaits `waitForExit` reaches it — one
  // that starts a command and reads `status()` would otherwise keep the process running until
  // the timeout elapsed, which for an agent turn's budget is hours after the work is done.
  // Measured: a 30s budget held the host open for the full 30s.
  timer?.unref()

  const record: ProcessRecord = {
    command,
    argv,
    cwd: options.cwd === undefined ? handle.cwd : resolveVirtualPath(handle.cwd, options.cwd),
    startedAt: command.startedAt.toISOString(),
    timedOut: () => expired,
    settle: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    },
  }
  processes.set(command.cmdId, record)
  return createProcessHandle(command.cmdId, record)
}

export interface JustBashSessionOptions {
  handle: JustBashHandle
  /**
   * Where this sandbox's processes are registered.
   *
   * Owned by the provider rather than created here, because `SandboxProvider.session` is called
   * per use rather than held: a registry created per session object would answer `getProcess` and
   * `listProcesses` only for the one session that ran the command, and `null` for the next call
   * over the same sandbox id.
   */
  processes?: Map<string, ProcessRecord>
}

export function createJustBashSession(options: JustBashSessionOptions): SandboxSession {
  const { handle } = options
  const processes = options.processes ?? new Map<string, ProcessRecord>()
  const files = createJustBashFiles(handle)

  return {
    ...files,
    exec: (command, execOptions) => exec(handle, processes, command, execOptions),
    getProcess: async (processId) => {
      // Discovery must not create: a sandbox that was never started has run nothing, and asking
      // the question should not be what brings it into being.
      if (handle.peek() === undefined) {
        return null
      }
      const record = processes.get(processId)
      return record === undefined ? null : createProcessHandle(processId, record)
    },
    listProcesses: async (): Promise<ProcessStatus[]> => {
      if (handle.peek() === undefined) {
        return []
      }
      return [...processes].map(([id, record]) => toProcessStatus(id, record))
    },
    exists: async (path) => {
      const sandbox = await handle.ready()
      // `test -e` rather than a failed read: the contract's `exists` answers for directories too,
      // and the vendor's `readFile` does not.
      const probe = await sandbox.runCommand({
        cmd: 'test',
        args: ['-e', resolveVirtualPath(handle.cwd, path)],
        detached: true,
      })
      const { exitCode } = await probe.wait()
      return { exists: exitCode === 0 }
    },
    destroy: async () => {
      processes.clear()
      await handle.destroy()
    },
  }
}
