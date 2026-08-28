/**
 * The escape sequences the boot chrome writes, named.
 *
 * Built from `String.fromCharCode(27)` rather than a literal escape so the source stays
 * copy-pasteable and greppable: a raw control byte in a file is invisible in a diff, a review
 * comment, and half the tools that would show it.
 */

/** The escape character every sequence below starts with. */
export const ESC = String.fromCharCode(27)

/** Hide and show the hardware cursor. The renderer draws its own where it needs one. */
export const HIDE_CURSOR = `${ESC}[?25l`
export const SHOW_CURSOR = `${ESC}[?25h`

/** Erase from the cursor to the end of the screen. */
export const CLEAR_TO_END = `${ESC}[0J`

/**
 * Synchronized update markers.
 *
 * A terminal that understands them presents the whole repaint at once instead of showing the
 * cleared-but-not-yet-redrawn intermediate state; one that does not ignores them as an
 * unknown private mode. Either way the sequence is safe to emit.
 */
export const SYNC_START = `${ESC}[?2026h`
export const SYNC_END = `${ESC}[?2026l`

/** Move the cursor up `lines` lines and to column 0 (CPL). Treats 0 as 1, so callers guard. */
export function cursorPreviousLine(lines: number): string {
  return `${ESC}[${lines}F`
}
