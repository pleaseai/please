/**
 * One virtual sandbox, as the contract's {@link SandboxSession}.
 *
 * The process registry is a `Map` in this object rather than anything on disk, and that is not a
 * shortcut — see `./sandbox.ts` for why a backend whose filesystem is a heap object has nothing
 * to resume from. `getProcess` and `listProcesses` answer for the life of this provider.
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
  const timer = options.timeout === undefined
    ? undefined
    : setTimeout(() => {
        expired = true
        controller.abort()
      }, options.timeout)

  const command = await sandbox.runCommand({
    cmd: executable,
    args,
    detached: true,
    signal: controller.signal,
    ...(options.cwd === undefined ? {} : { cwd: resolveVirtualPath(handle.cwd, options.cwd) }),
  })

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
}

export function createJustBashSession(options: JustBashSessionOptions): SandboxSession {
  const { handle } = options
  const processes = new Map<string, ProcessRecord>()
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
