/**
 * Escape-sequence removal for text the CLI did not author.
 *
 * Every string the boot chrome prints — a docker progress line, an adapter's stderr, a
 * container id — is text some other program produced, and any of it may carry escape
 * sequences. Left in place they do more than look wrong: the live region's repaint counts
 * screen rows, and a stray cursor movement inside a row it did not write makes that count a
 * lie for the rest of the run.
 *
 * Stripping the escape *character* alone is not enough, because the rest of the sequence
 * (`[31m`) is ordinary text and would stay visible. So sequences are skipped as units:
 * CSI runs to its final byte, string controls (OSC, DCS, …) run to their terminator, and
 * charset designations consume their argument.
 *
 * Derived from vercel/eve `packages/eve/src/cli/ui/output.ts` (Apache-2.0) — see NOTICE.
 */

const ESCAPE = 0x1B
const BELL = 0x07
const STRING_TERMINATOR = 0x9C
const CSI_INTRODUCER = 0x5B
const CSI_FINAL_BYTE_START = 0x40
const CSI_FINAL_BYTE_END = 0x7E
const STRING_TERMINATOR_BACKSLASH = 0x5C

interface Scan {
  readonly value: string
  readonly start: number
}

/** ESC-introduced string controls: DCS, SOS, OSC, PM, APC. */
function isEscStringControl(codePoint: number): boolean {
  return codePoint === 0x50 || codePoint === 0x58 || codePoint === 0x5D
    || codePoint === 0x5E || codePoint === 0x5F
}

/** The same five controls in their single-byte C1 spellings. */
function isC1StringControl(codePoint: number): boolean {
  return codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9D
    || codePoint === 0x9E || codePoint === 0x9F
}

/** `ESC ( B` and friends: the next code point is the sequence's argument, not text. */
function isCharsetDesignation(codePoint: number): boolean {
  return (codePoint >= 0x28 && codePoint <= 0x2B)
    || (codePoint >= 0x2D && codePoint <= 0x2F)
}

/** C0 and C1 controls, minus the newline and carriage return a caller may legitimately want. */
function isUnsafeControl(codePoint: number): boolean {
  return (codePoint >= 0x00 && codePoint <= 0x08)
    || (codePoint >= 0x0B && codePoint <= 0x1F)
    || (codePoint >= 0x7F && codePoint <= 0x9F)
}

/** Skip to just past a CSI sequence's final byte. */
function skipCsi(scan: Scan): number {
  let index = scan.start
  while (index < scan.value.length) {
    const codePoint = scan.value.codePointAt(index)
    if (codePoint === undefined) {
      break
    }
    index += String.fromCodePoint(codePoint).length
    if (codePoint >= CSI_FINAL_BYTE_START && codePoint <= CSI_FINAL_BYTE_END) {
      return index
    }
  }
  return index
}

/** Skip to just past a string control's terminator: BEL, ST, or `ESC \`. */
function skipStringControl(scan: Scan): number {
  let index = scan.start
  while (index < scan.value.length) {
    const codePoint = scan.value.codePointAt(index)
    if (codePoint === undefined) {
      break
    }
    const next = index + String.fromCodePoint(codePoint).length
    if (codePoint === BELL || codePoint === STRING_TERMINATOR) {
      return next
    }
    if (codePoint === ESCAPE && scan.value.codePointAt(next) === STRING_TERMINATOR_BACKSLASH) {
      return next + 1
    }
    index = next
  }
  return index
}

/** Skip whatever an ESC introduced, returning the index of the next text code point. */
function skipEscape(scan: Scan): number {
  const next = scan.start + 1
  const codePoint = scan.value.codePointAt(next)
  if (codePoint === undefined) {
    return next
  }
  if (codePoint === CSI_INTRODUCER) {
    return skipCsi({ value: scan.value, start: next + 1 })
  }
  if (isEscStringControl(codePoint)) {
    return skipStringControl({ value: scan.value, start: next + 1 })
  }

  const width = String.fromCodePoint(codePoint).length
  if (!isCharsetDesignation(codePoint)) {
    return next + width
  }

  // The designation's argument is one more code point, and it is not text either.
  const argument = next + width
  const argumentCodePoint = scan.value.codePointAt(argument)
  return argumentCodePoint === undefined
    ? argument
    : argument + String.fromCodePoint(argumentCodePoint).length
}

/**
 * Remove escape sequences and unsafe control characters, leaving the printable text.
 *
 * The newline and the tab survive, because callers lay text out with them — a section value
 * is split on newlines deliberately. Every other control character goes, the carriage return
 * included: a CR inside a row returns the cursor to column 0 mid-paint, and the live region
 * cannot recover a row count from that.
 */
export function sanitizeForTerminal(input: string): string {
  let output = ''
  let index = 0

  while (index < input.length) {
    const codePoint = input.codePointAt(index)
    if (codePoint === undefined) {
      break
    }

    if (codePoint === ESCAPE) {
      index = skipEscape({ value: input, start: index })
      continue
    }
    if (codePoint === 0x9B) { // C1 CSI
      index = skipCsi({ value: input, start: index + 1 })
      continue
    }
    if (isC1StringControl(codePoint)) {
      index = skipStringControl({ value: input, start: index + 1 })
      continue
    }

    const character = String.fromCodePoint(codePoint)
    index += character.length
    if (!isUnsafeControl(codePoint)) {
      output += character
    }
  }

  return output
}
