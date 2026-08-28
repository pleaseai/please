/**
 * The agent: a harness, a sandbox, and a workspace.
 *
 * The harness adapter comes from the AI SDK directly and is not wrapped by `please` — the
 * harness boundary is the AI SDK's, and a re-export here would buy nothing. What `defineAgent`
 * adds is the part no adapter exposes: where the run happens, and which directory is carried
 * into it.
 */
import process from 'node:process'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { defineAgent } from '@pleaseai/core'
import sandbox from './sandbox'

export default defineAgent({
  harness: createClaudeCode({
    auth: 'auto',
    model: process.env.EXAMPLE_MODEL ?? 'claude-sonnet-5',
    // Pinned rather than inherited: the credential is forwarded into the sandbox, and a host
    // whose ANTHROPIC_BASE_URL points at a gateway would send a Console key somewhere that
    // rejects it. Set ANTHROPIC_BASE_URL yourself when the key belongs to a gateway.
    env: { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com' },
  }),

  sandbox,

  // The one route an authored file has into the runtime. Everything under this directory is
  // written into the session's working directory before the adapter starts — which is also why
  // the `CLAUDE.md` in there reaches the model's instructions rather than just sitting on disk.
  //
  // A `URL` rather than `'./workspace'`: a bare string resolves against the process's working
  // directory, which is a property of how the program was launched, not of where this file is.
  workspace: new URL('./workspace/', import.meta.url),

  instructions: 'You are working in a small JavaScript project. Explain what you changed.',
})
