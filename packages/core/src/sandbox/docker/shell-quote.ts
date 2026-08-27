/**
 * POSIX shell quoting for the journal wrapper.
 *
 * `exec` receives argv, never a shell string, and `docker exec` passes argv straight to
 * `execve` — so nothing here would be needed if a process only had to be *started*. It is
 * needed because a journalled process is started through `sh -c`, which is what redirects
 * its streams to files that outlive it, and that reintroduces a shell between the caller's
 * argv and the process. Quoting here is what keeps the two equivalent.
 */

/**
 * Wrap one argument so a POSIX shell reproduces it byte for byte.
 *
 * Single quotes suspend every expansion the shell performs, so the only character needing
 * care is the single quote itself: close the literal, emit an escaped quote, reopen it.
 */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll('\'', '\'\\\'\'')}'`
}

/** Quote a whole argv into one shell-safe command string. */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}
