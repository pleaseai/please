/**
 * The boot chrome — everything `please dev` draws before the interactive UI takes the screen.
 *
 * The division is deliberate and is the whole reason this module is small. `@ai-sdk/tui` owns
 * the session: it enters the alternate screen buffer, renders the transcript, tool sections,
 * reasoning and approval prompts, and restores the terminal on exit. What it does not cover is
 * everything either side of that — the banner, the phases of bringing a sandbox up, and the
 * summary left behind afterwards — because none of it exists once an agent is streaming.
 *
 * So this is not a terminal UI framework. It is the main screen's half of one.
 */

export { ESC } from './ansi'

export { type BootRow, type BootRowOptions, type BootRowOutput, startBootRow } from './boot-row'

export { LiveRegion, type LiveRegionOptions, type LiveRegionOutput } from './live-region'

export {
  assertPulseSequence,
  InvalidPulseSequenceError,
  isProgressPulseVisible,
  PROGRESS_PULSE_ASCII_GLYPH,
  PROGRESS_PULSE_DURATION_MS,
  PROGRESS_PULSE_GLYPH,
  PROGRESS_PULSE_SEQUENCE,
  pulseStepDurationMs,
} from './progress-pulse'

export { sanitizeForTerminal } from './sanitize'

export { clipVisible, ellipsize, sliceVisible, visibleLength } from './text'

export {
  type CliRow,
  type CliTheme,
  type CliTone,
  createCliTheme,
  renderCliBanner,
  renderCliSection,
  renderCliTaggedLine,
} from './theme'
