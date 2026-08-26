# Prior art

What the neighbouring frameworks actually do, read from their own documentation rather than from
recollection, so that design arguments here start from what exists.

All three sources read **2026-08-26**. Documentation sites show the latest version, so re-read
before leaning on any specific signature.

## The AI SDK harness contract

Sources: [harness agent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent),
[harness adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)

`HarnessAgent` (from `@ai-sdk/harness/agent`) is an AI SDK `Agent` whose turns run through a
**harness adapter**. The adapter supplies the runtime, its native conversation history, its built-in
tools, and any sandbox or bridge requirement; the agent exposes AI SDK-shaped `generate()` and
`stream()` on top.

Construction takes `harness`, `sandbox` (a `HarnessV1SandboxProvider`), `instructions`, `output`,
`stopWhen`, `tools` / `activeTools` / `inactiveTools`, `skills`, `permissionMode`, `toolApproval`,
`sandboxConfig`, and telemetry options. Adapter-specific settings live on the adapter factory
instead (`createCodex({ reasoningEffort: 'high' })`).

Sessions are explicit: `agent.createSession({ sessionId, resumeFrom, continueFrom, sandboxSession })`
returns a session, and turns run as `generate` / `stream` / `continueGenerate` / `continueStream`
against it. `suspendTurn()`, `hasUnfinishedTurn()`, `detach()`, `stop()` and `destroy()` cover the
lifecycle. `stopWhen` can end a result after a completed tool step while leaving the turn resumable.

Adapters and where each runs:

| Adapter | Package | Runtime |
| --- | --- | --- |
| Claude Code | `@ai-sdk/harness-claude-code` | Sandbox bridge |
| Codex | `@ai-sdk/harness-codex` | Sandbox bridge |
| OpenCode | `@ai-sdk/harness-opencode` | Sandbox bridge |
| Deep Agents | `@ai-sdk/harness-deepagents` | Sandbox bridge |
| Cursor | `@ai-sdk/harness-cursor` | Sandbox via ACP |
| fx | `@ai-sdk/harness-fx` | Sandbox via ACP |
| Grok Build | `@ai-sdk/harness-grok-build` | Sandbox via ACP |
| Cline | `@ai-sdk/harness-cline` | Host process |
| Pi | `@ai-sdk/harness-pi` | Host process |

Listed as upcoming: Amp, Goose, Mastra.

The bridge/host split is the load-bearing distinction for us: a bridged adapter needs a sandbox that
runs real processes and exposes a port, a host adapter does not. `prepareHarnessSandboxTemplate()`
and `prepareSandboxForHarness()` exist for the bootstrap side of that.

**What this means for `please`:** the agent loop, the adapter contract, and structured output are
already someone else's problem. What is left is placement (which sandbox, which target), reach
(which channel), and sequencing (which workflow).

## flue

Source: [flueframework.com/docs](https://flueframework.com/docs)

**Project layout** is lightly prescribed. `src/app.ts` is the required server and router entrypoint;
`src/db.ts` and `src/cloudflare.ts` are optional specialized entrypoints; agent code sits in
`agent.ts` with `skills/`, `tools/`, `subagents/`, `channels/` beside it, grouped under
`agents/<name>/` for multi-agent projects. Flue resolves `.flue/`, then `src/`, then the project
root, taking the first that exists rather than merging. `flue.config.ts` can override entry paths.
Notably, **there is no workflow directory convention.**

**Targets.** Cloudflare compiles each exported agent into a generated Durable Object class inside
one Worker (`export function SupportChat()` → `FlueSupportChatAgent`, bound as
`env.FLUE_SUPPORT_CHAT_AGENT`); conversations, attachments and accepted submissions live in Durable
Object SQLite, and `db.ts` is not supported there. The build is Vite-owned — `flue()` must come
first in `vite.config.ts` — and Wrangler needs `nodejs_compat` plus an append-only `new_sqlite_classes`
migration history. Node builds to `dist/server.mjs`, serves on port 3000, and is the only target
with a host sandbox (`useSandbox(local())`); without `db.ts` its state is in-process and vanishes on
restart, and exactly one live process must own each conversation.

**Workflows** are deliberately *not* a Flue construct. The docs define a workflow as any code that
invokes an agent outside a running chatbot — a CLI run, a Node program, an HTTP client, or a durable
orchestrator (Cloudflare Workflows, Inngest, Temporal). The framework contribution is that each
admitted message has a durable outcome: `dispatch()` returns a receipt, `read(receipt)` settles it,
and because `read()` does not depend on in-memory state another process can collect the result
later. The residual hole is named honestly — if admission succeeds but the workflow dies before
persisting the receipt, an unconditional retry duplicates; a create-only send (`uid: null`) rejects
with `AgentInstanceExistsError` instead.

**Sandbox API.** `SandboxFactory.createSandbox({ id })` returns a `Sandbox` with `exec`, `readFile`,
`readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`, plus `cwd` and
`resolvePath`. `sandboxFromDriver(driver, cwd)` wraps a thinner `SandboxDriver` and supplies path
resolution, the parent-directory retry on write, and abort handling — including reporting an
orphaned exec that settles after its caller aborted. Built-ins: `bash()` over just-bash, `local()`
for Node, `cloudflareSandbox(stub)` for the Cloudflare Sandbox Durable Object. The stub is
structural, so the adapter carries no type dependency on the Cloudflare package.
`SandboxOperationUnsupportedError` is how a provider refuses an option it cannot honour, and it must
reject before changing anything.

**Evals** are Vitest tests under `src/evals/**/*.eval.ts` with their own config, run in-process via
`start()` / `init()` / `dispatch()` / `read()` or over HTTP via `createFlueClient()`. `vitest-evals`
adds model judges (`FactualityJudge`, `ToolCallJudge`, `StructuredOutputJudge`) reached through
`toSatisfyJudge(...)`, with `createJudge()` for custom ones. The guidance is to prefer deterministic
assertions and reserve judges for semantics.

**`flue add`** does not install anything: it prints a Markdown blueprint for a coding agent to
follow, across `channel`, `database`, `sandbox` and `tooling` kinds — or from an arbitrary provider
documentation URL.

## eve

Sources: [eve.dev/docs](https://eve.dev/docs/getting-started),
[Slack integration](https://eve.dev/integrations/slack),
[agent-browser](https://eve.dev/integrations/agent-browser),
[evals](https://eve.dev/docs/evals/overview)

**Filesystem as the definition.** Everything under `agent/` is discovered and compiled:
`instructions.md` (root system prompt), `agent.ts` (model, compaction, build), `tools/`,
`connections/` (MCP or OpenAPI), `skills/`, `hooks/`, `sandbox/`, `subagents/<id>/agent.ts`,
`schedules/`, `channels/`. Names come from paths — `tools/get_weather.ts` is `get_weather` — so
there is no `name` field to keep in sync. `defineSchedule` is the one API the getting-started page
names; the rest is convention.

**Channels** are root-agent-only entry points under `agent/channels/`. Slack is scaffolded with
`eve add channel/slack`, and authenticates through Vercel Connect
(`slackChannel({ credentials: connectSlackCredentials("slack/my-agent") })`) with the Vercel project
attached as a webhook trigger destination at `/eve/v1/slack`. That is a real coupling: the
integration's credential and webhook story is Vercel's, not the framework's.

**Extensions** follow the same shape — `eve add extension/agent-browser`, then
`agent/extensions/browser.ts` default-exporting `browser({})`, with the filename becoming the tool
namespace (`browser__navigate`, `browser__click`, …). It requires a sandbox that can run real
processes (Vercel Sandbox, Docker, microsandbox).

**Evals** live in `evals/**/*.eval.ts` with one `evals.config.ts` per root, identity taken from the
path. `defineEval({ async test(t) { … } })` drives a real agent server over the same HTTP protocol
users hit; `eve eval` can target a remote deployment with `--url`. Three assertion styles: run/turn
methods, deterministic `t.check(value, matcher)`, and `t.judge.autoevals.*`. Success checks and
matchers gate by default while similarity and judge checks are soft, adjustable with `.gate()`,
`.soft()` and `.atLeast()`; soft misses become fatal under `--strict`. `mockModel` makes a case
deterministic without a provider.

## What `please` takes, and where it diverges

**Takes.** flue's insistence that a workflow is ordinary orchestration code rather than a framework
construct, and that the framework's job is a durable receipt. flue's sandbox contract shape —
narrow driver, wrapper supplying path resolution and abort semantics, structural stubs so the
contract carries no provider type dependency. eve's path-as-identity convention, which removes a
whole class of drift between a declared name and a file name. Both projects' separation of evals
from unit tests, and their shared conclusion that deterministic assertions should be preferred over
judges.

**Diverges.** Both drive a model and own the agent loop. `please` drives a harness and owns none of
it, which moves the hard problems: session identity and resume belong to the adapter, but sandbox
lifetime, bridge reachability and duplicate-turn prevention become ours. Neither treats two deploy
targets as equally first-class — flue's Cloudflare target cannot use `db.ts` and its Node target is
the only one with a host sandbox; eve's Slack integration authenticates through Vercel Connect.
Carrying Cloudflare and Vercel side by side means those asymmetries have to be designed for rather
than inherited.

**Still open.** Neither answers what `please` most needs to decide: what a channel handler receives
when the same agent is reachable from Slack, GitHub and Linear at once, and how a bridged harness's
sandbox lifetime is tied to a durable workflow's step boundaries.
