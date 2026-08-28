/**
 * The inline repaint engine: a few rows redrawn in place, above untouched scrollback.
 *
 * Deliberately *not* the alternate screen buffer. `@ai-sdk/tui` takes that buffer when the
 * interactive session starts, and everything it draws there disappears when it exits. The boot
 * chrome runs before that hand-off and belongs to the main screen, where its output survives —
 * a run that fails to reach the TUI at all has to leave its diagnosis behind on the terminal.
 *
 * Two regions are maintained. Committed rows are printed once and owned by the terminal
 * thereafter; live rows are redrawn on every update by moving to the top of the previous live
 * region, clearing to the end of the screen, and reprinting.
 *
 * Writes go through the `write` captured at construction so that a later stdout interception —
 * the usual way a CLI captures a subprocess's output — never sees the engine's own paints and
 * mistakes them for program output.
 *
 * Derived from vercel/eve `packages/eve/src/cli/ui/live-region.ts` (Apache-2.0) — see NOTICE.
 */

import { CLEAR_TO_END, cursorPreviousLine, HIDE_CURSOR, SHOW_CURSOR, SYNC_END, SYNC_START } from './ansi'

export interface LiveRegionOutput {
  write: (chunk: string) => unknown
}

export interface LiveRegionOptions {
  /** Wrap each paint in synchronized-update markers to avoid a visible flicker. */
  readonly synchronized?: boolean
}

export class LiveRegion {
  readonly #write: (chunk: string) => unknown
  readonly #synchronized: boolean
  /** Screen rows the live region currently occupies. */
  #liveRowCount = 0

  constructor(output: LiveRegionOutput, options: LiveRegionOptions = {}) {
    this.#write = output.write.bind(output)
    this.#synchronized = options.synchronized ?? true
  }

  hideCursor(): void {
    this.#write(HIDE_CURSOR)
  }

  showCursor(): void {
    this.#write(SHOW_CURSOR)
  }

  /**
   * Repaint the live region from `liveRows`.
   *
   * Each row must already be styled and fit the terminal width: one row is one screen line,
   * and a row that wraps makes the row count — and therefore every later repaint — wrong.
   */
  update(liveRows: readonly string[]): void {
    this.#paint([], liveRows)
  }

  /** Commit rows to scrollback above the live region, then repaint it. */
  flush(committedRows: readonly string[], liveRows: readonly string[]): void {
    this.#paint(committedRows, liveRows)
  }

  /** Erase the live region, leaving committed scrollback and the cursor at its former top. */
  clear(): void {
    if (this.#liveRowCount === 0) {
      this.#write(`\r${CLEAR_TO_END}`)
      return
    }
    this.#write(`${this.#moveToTop()}${CLEAR_TO_END}`)
    this.#liveRowCount = 0
  }

  #paint(committedRows: readonly string[], liveRows: readonly string[]): void {
    const body = this.#moveToTop()
      + CLEAR_TO_END
      + committedRows.map(row => `${row}\n`).join('')
      + liveRows.join('\n')

    this.#write(this.#synchronized ? `${SYNC_START}${body}${SYNC_END}` : body)
    this.#liveRowCount = liveRows.length
  }

  /**
   * The sequence that returns to column 0 of the first live row.
   *
   * After a paint the cursor sits at the end of the last live row, so the move is
   * `liveRowCount - 1` lines up. CPL treats a 0 parameter as 1, so a single row — or none at
   * all — uses a bare carriage return instead.
   */
  #moveToTop(): string {
    return this.#liveRowCount <= 1 ? '\r' : cursorPreviousLine(this.#liveRowCount - 1)
  }
}
