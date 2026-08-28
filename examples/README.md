# Examples

Runnable programs, one directory each. Every example says in its own README what it needs and
what it demonstrates.

| Example | What it shows |
| --- | --- |
| [`claude-code-docker`](./claude-code-docker) | Claude Code driven as a harness inside a local Docker sandbox, fixing a file seeded into its workspace |

Each example is a private workspace package, so `bun run type-check` at the repository root
covers them too — an example that stops compiling against `@pleaseai/core` fails CI rather than
rotting quietly.

## What is example and what is framework

`@pleaseai/core` supplies where an agent runs and what is carried into it: `defineAgent`,
`defineSandbox`, the sandbox contract and its backends. The harness adapter is **not** ours —
`createClaudeCode()` comes from `@ai-sdk/harness-claude-code` and is passed through unwrapped,
because the harness boundary belongs to the AI SDK. An example importing an adapter directly is
the design, not a gap to be filled in later.

The framework API is young; see the [status section](../README.md#status) before quoting a
signature as settled.
