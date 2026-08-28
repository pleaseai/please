import { describe, expect, it } from 'bun:test'
import { turnFrom } from '../../src/agent/define'

/**
 * A stand-in for the AI SDK's result, whose `text` reads through to the final step — and
 * throws when the step list is empty, which is the case the guard exists for.
 */
function generateResult(steps: { toolCalls: { toolName: string }[], text: string }[]): never {
  const result = {
    steps,
    usage: { totalTokens: 1 },
    get text(): string {
      const final = steps.at(-1)
      if (final === undefined) {
        throw new TypeError('undefined is not an object (evaluating \'this.finalStep.text\')')
      }
      return final.text
    },
  }
  return result as never
}

describe('turnFrom', () => {
  it('collects the text and every tool call across steps', () => {
    const turn = turnFrom(generateResult([
      { toolCalls: [{ toolName: 'read' }, { toolName: 'edit' }], text: '' },
      { toolCalls: [{ toolName: 'Agent' }], text: 'done' },
    ]))

    expect(turn.text).toBe('done')
    expect(turn.toolCalls).toEqual(['read', 'edit', 'Agent'])
  })

  it('answers a turn that produced no step at all with empty text', () => {
    // Without the guard this is a TypeError thrown from inside the AI SDK's own getter, which
    // reaches the caller as a crash rather than as an empty answer. Observed against a live
    // runtime: a follow-up prompt sent while a background subagent from the previous turn was
    // still running came back with no steps.
    const turn = turnFrom(generateResult([]))

    expect(turn.text).toBe('')
    expect(turn.toolCalls).toEqual([])
  })
})
