/**
 * The palette, and the pieces of chrome drawn with it.
 *
 * Colour is resolved once at construction rather than per call, so a run piped to a file or
 * a CI log prints the same text without escapes rather than the same text with them.
 *
 * Derived from vercel/eve `packages/eve/src/cli/ui/output.ts` (Apache-2.0) — see NOTICE.
 */

import process from 'node:process'
import picocolors from 'picocolors'
import { sanitizeForTerminal } from './sanitize'

export type CliTone
  = | 'accent'
    | 'danger'
    | 'default'
    | 'info'
    | 'muted'
    | 'success'
    | 'warning'

export interface CliTheme {
  /** Whether the palette actually emits escapes. */
  readonly color: boolean
  accent: (text: string) => string
  danger: (text: string) => string
  heading: (text: string) => string
  info: (text: string) => string
  label: (text: string) => string
  muted: (text: string) => string
  plain: (text: string) => string
  success: (text: string) => string
  warning: (text: string) => string
}

/** One labelled value in a section. */
export interface CliRow {
  readonly label: string
  readonly value: string
  readonly tone?: CliTone
}

export function createCliTheme(options: { color?: boolean } = {}): CliTheme {
  const colors = picocolors.createColors(options.color ?? Boolean(process.stdout.isTTY))

  return {
    color: colors.isColorSupported,
    accent: text => colors.cyan(text),
    danger: text => colors.red(text),
    heading: text => colors.bold(colors.cyan(text)),
    info: text => colors.blue(text),
    label: text => colors.bold(text),
    muted: text => colors.dim(text),
    plain: text => text,
    success: text => colors.green(text),
    warning: text => colors.yellow(text),
  }
}

function applyTone(theme: CliTheme, tone: CliTone, value: string): string {
  switch (tone) {
    case 'accent': return theme.accent(value)
    case 'danger': return theme.danger(value)
    case 'info': return theme.info(value)
    case 'muted': return theme.muted(value)
    case 'success': return theme.success(value)
    case 'warning': return theme.warning(value)
    default: return theme.plain(value)
  }
}

/** Indent every line after the first, so a multi-line value stays under its own column. */
function indentContinuation(lines: readonly string[], indent: string): string[] {
  const [first = '', ...rest] = lines
  return [first, ...rest.map(line => `${indent}${line}`)]
}

/** A title with a rule under it, and an optional subtitle. */
export function renderCliBanner(
  theme: CliTheme,
  input: { readonly title: string, readonly subtitle?: string },
): string {
  const title = sanitizeForTerminal(input.title)
  const lines = [theme.heading(title), theme.muted('='.repeat(title.length))]
  if (input.subtitle !== undefined) {
    lines.push(theme.muted(sanitizeForTerminal(input.subtitle)))
  }
  return lines.join('\n')
}

/**
 * A titled block of labelled values, with the values aligned to one column.
 *
 * Padding is by `label.length` rather than visible width because labels are authored here,
 * not received — an English identifier, never user text. Values are sanitized because they
 * are the opposite: a container id, a path, an error a process produced.
 */
export function renderCliSection(
  theme: CliTheme,
  input: { readonly title: string, readonly rows: readonly CliRow[] },
): string {
  const rows = input.rows.map(row => ({
    label: sanitizeForTerminal(row.label),
    value: sanitizeForTerminal(row.value),
    tone: row.tone,
  }))
  const labelWidth = rows.reduce((width, row) => Math.max(width, row.label.length), 0)
  const lines = [theme.accent(sanitizeForTerminal(input.title))]

  for (const row of rows) {
    const value = applyTone(theme, row.tone ?? 'default', row.value)
    const [first = '', ...rest] = indentContinuation(
      value.split('\n'),
      `${' '.repeat(labelWidth)}  `,
    )
    lines.push(`${theme.label(row.label.padEnd(labelWidth))}  ${first}`)
    lines.push(...rest)
  }

  return lines.join('\n')
}

/** One `[TAG] message` line, for the phases the boot prints before the TUI takes over. */
export function renderCliTaggedLine(
  theme: CliTheme,
  input: { readonly tag: string, readonly message: string, readonly tone?: CliTone },
): string {
  const prefix = `[${sanitizeForTerminal(input.tag).toUpperCase()}]`
  const message = applyTone(theme, input.tone ?? 'default', sanitizeForTerminal(input.message))
  const [first = '', ...rest] = indentContinuation(
    message.split('\n'),
    `${' '.repeat(prefix.length)} `,
  )
  const head = `${theme.muted(prefix)} ${first}`
  return rest.length === 0 ? head : `${head}\n${rest.join('\n')}`
}
