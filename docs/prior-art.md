# Prior art

What the neighbouring frameworks actually do, read from their own documentation rather than from
recollection, so that design arguments here start from what exists.

The flue and eve sections were read **2026-08-26**. The AI SDK harness contract was re-read and
expanded **2026-08-27** across the overview, harness agent, adapters, tools, skills, terminal UI and
Claude Code adapter pages. Documentation sites show the latest version, so re-read before leaning on
any specific signature. The harness packages are marked experimental and warn of breaking changes
between releases.

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

### What the contract actually accepts (read 2026-08-27)

The shapes below are the ones that constrain a project layout, because they decide what has to be
authored on disk and what has to be built before a turn can run.

**`skills` takes inline objects, not paths.** Each entry is
`{ name, description, content, files?: Array<{ path, content }> }`, where `files` carries
skill-relative POSIX paths. No documented form accepts a directory or a file path, and no `Skill`
type is named. Anything authored on disk has to be read and turned into these objects before the
agent is constructed.

**`tools` run in the host process, not the sandbox.** They are ordinary AI SDK tools; their results
are submitted back to the runtime. A tool may reach the sandbox through `experimental_sandbox`
(read/write files, run commands) but cannot stop the sandbox or change its network policy. Built-in
tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `webSearch`) belong to the adapter runtime
instead. `activeTools` and `inactiveTools` name entries from the combined set and are mutually
exclusive — the settings type rejects both, and so does the constructor at runtime.

**`permissionMode` has three values**: `allow-all` (default), `allow-edits`, `allow-reads`. It
governs adapter-native built-in permissions only. Host tools are governed separately by
`toolApproval`, whose statuses are `not-applicable`, `approved`, `user-approval` and `denied`.

**Files reach the sandbox through hooks, not a mount option.** `sandboxConfig` takes `workDir`,
`bootstrapHash`, `onBootstrap({ session, abortSignal })` and
`onSession({ session, sessionWorkDir, abortSignal })`. `onBootstrap` runs during template creation,
after adapter bootstrap and before the snapshot is published, so its output is baked into a reusable
snapshot and `bootstrapHash` is what invalidates it. `onSession` runs after every session is
acquired, resumed ones included. The documented way to place a file is `writeTextFile` inside a hook.

**`instructions` is a single string**, appended to the system prompt where the adapter supports it
and otherwise prepended to the first user prompt.

`@ai-sdk/tui` (`runAgentTUI`) renders an interactive terminal interface over a session; the page
frames it as developer-facing rather than production hosting.

### The Claude Code adapter's own settings (read 2026-08-27)

Source: [Claude Code adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code)

`createClaudeCode()` accepts `auth` (`'auto' | 'direct' | 'ai-gateway'`), `credentialForwarding`,
`mcpServers` (keyed by name; the server-definition schema is not given), `model`, `maxTurns`, `env`
(merged over the bridge process environment, taking precedence), `thinking`
(`{ type: 'enabled' | 'disabled' | 'adaptive', display: 'summarized' | 'omitted' }`, defaulting to
adaptive/summarized), `port`, `startupTimeoutMs` and `mintBridgeToken`.

The adapter is built on `@anthropic-ai/claude-agent-sdk` — not the Claude Code CLI — and installs
its bridge dependencies inside the sandbox when the first session begins, then talks to the host
over a sandbox-exposed WebSocket.

**What the adapter page does not document:** a `.claude` directory, a settings file, `CLAUDE.md`,
plugins, subagents, hooks, slash commands, settings-source selection, or allowed/disallowed tool
lists. None of these appear as adapter settings.

This is load-bearing and uncomfortable, because the README argues that reusing the harness brings
its ecosystem along. Measured against the contract as documented, that holds for the built-in tools,
the native conversation state and compaction, and the session/resume story — and does not hold for
skills, which have to be rebuilt as inline objects; for the permission model, which flattens to
three values; or for plugins, which the contract does not mention at all. Whether a `.claude`
directory seeded into the workspace by `onSession` is read by the Agent SDK is **not documented
either way**, and is worth verifying against the real package before any design leans on it.

**What this means for `please`:** the agent loop, the adapter contract, and structured output are
already someone else's problem. What is left is placement (which sandbox, which target), reach
(which channel), and sequencing (which workflow).

## flue

Source: [flueframework.com/docs](https://flueframework.com/docs)

**Project layout** is lightly prescribed. `src/app.ts` is the required server and router entrypoint;
`src/db.ts` and `src/cloudflare.ts` are optional specialized entrypoints; agent code sits in
`agent.ts` with `skills/`, `tools/`, `subagents/`, `channels/` beside it, grouped under
`agents/<name>/` for multi-agent projects, which also get an `agents/shared/` area. Flue resolves
`.flue/`, then `src/`, then the project root, taking the first that exists rather than merging —
if `.flue/` exists, the entrypoints and the `'use agent'` scan resolve there and the other locations
are not consulted. `flue.config.ts` can override the `app.ts` / `db.ts` / `cloudflare.ts` paths, and
`vite build` writes to `dist/` unless `vite.config.ts` says otherwise. Notably, **there is no
workflow directory convention.**

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
there is no `name` field to keep in sync. The root agent instead takes its name from `package.json`,
or the directory name when there is none. `defineSchedule` is the one API the getting-started page
names; the rest is convention.

Three details read 2026-08-27 bear directly on placement. **Not everything authored is mounted**:
`agent/sandbox/workspace/**` is copied into `/workspace/` at session start, while `agent/lib/` is
import-only and never reaches the sandbox; a bare `agent/sandbox.ts` declares a sandbox with no
seeded files. **Skills are seeded at runtime** into `$HOME/.agents/skills/`, with `/workspace/skills/`
as the fallback. And **some things are root-only**: `channels/`, `schedules/` and
`instrumentation.ts` cannot appear under a subagent, which may otherwise carry its own connections,
hooks, skills, lib, sandbox, tools and nested subagents. `evals/` sits beside `agent/`, not inside
it. A flat layout — `agent.ts`, `instructions.md`, `tools/`, `skills/` directly beside
`package.json` — is permitted when the application root is the agent root, but the nested form is
the documented preference.

**Channels** are root-agent-only entry points under `agent/channels/`. Slack is scaffolded with
`eve add channel/slack`, and authenticates through Vercel Connect
(`slackChannel({ credentials: connectSlackCredentials("slack/my-agent") })`) with the Vercel project
attached as a webhook trigger destination at `/eve/v1/slack`. That is a real coupling: the
integration's credential and webhook story is Vercel's, not the framework's.

**Extensions** follow the same shape — `eve add extension/agent-browser`, then
`agent/extensions/browser.ts` default-exporting `browser({})`, with the filename becoming the tool
namespace (`browser__navigate`, `browser__click`, …). It requires a sandbox that can run real
processes (Vercel Sandbox, Docker, microsandbox).

> Read 2026-08-27, the getting-started page describes no `extensions/` directory and presents
> extension capability as arriving through tools, connections, skills, hooks, lib, sandboxes and
> subagents instead. The two pages may simply cover different ground, but the directory above comes
> from the integrations page alone and should be confirmed before it is treated as the convention.

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
sandbox lifetime is tied to a durable workflow's step boundaries. The second of those narrowed on
2026-08-27 — `detach()` and `stop()` return resume state that a session recreated with the same
`sessionId` and `resumeFrom` picks back up, which makes "a workflow step boundary is a detach point"
the first hypothesis to test rather than an open field.

The contract also opened questions the neighbours never had to answer. Host-executed `tools` run
wherever the application runs, so the same authored directory behaves differently on a Worker with a
per-invocation CPU limit than on a Node deployment with a real filesystem. Files reach the runtime by
three different routes with three different lifetimes — inline `skills`, per-session `onSession`
writes, and snapshot-baked `onBootstrap` output — so a layout that files them together hides which
is which. And whether an adapter-native `.claude` directory means anything once seeded is unverified,
which is the single question most worth answering before the layout is settled.
