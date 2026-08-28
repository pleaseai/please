# Prior art

What the neighbouring frameworks actually do, read from their own documentation rather than from
recollection, so that design arguments here start from what exists.

Where a claim here was **measured** rather than read, it says so and names the script that measured
it. Documentation and implementation had already diverged in several places by 2026-08-27, so the
distinction between "the page says" and "a live run showed" is load-bearing in this file.

The flue and eve sections were first read **2026-08-26** and extended **2026-08-27**. The AI SDK
harness contract was re-read and expanded **2026-08-27** across the overview, harness agent,
adapters, tools, skills, workflow utilities, terminal UI and Claude Code adapter pages; the `ui`
page is the one harness page still unread. On **2026-08-28** two more sources were added: the
Claude Agent SDK's own documentation, which is the layer *underneath* the adapter and settles what
a seeded directory is read for, and the source of eve's and flue's example applications, read from
their repositories rather than their docs sites. Documentation sites show the latest version, so re-read
before leaning on any specific signature. The harness packages are marked experimental and warn of
breaking changes between releases.

## The AI SDK harness contract

Sources: [overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview),
[harness agent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent),
[harness adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters),
[tools](https://ai-sdk.dev/docs/ai-sdk-harnesses/tools),
[skills](https://ai-sdk.dev/docs/ai-sdk-harnesses/skills),
[workflow utilities](https://ai-sdk.dev/docs/ai-sdk-harnesses/workflow-utilities),
[terminal UI](https://ai-sdk.dev/docs/ai-sdk-harnesses/terminal-ui)

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

**There are three tool surfaces, and `tools` is the one that runs in the host process.** Built-in
tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `webSearch`) belong to the adapter runtime;
`tools` are ordinary AI SDK tools executed by the host, with their results submitted back to the
runtime; external MCP tools are configured on the adapter (`mcpServers`), not on the agent. A host
tool may reach the sandbox through `experimental_sandbox` (read/write files, run commands) but
cannot stop the sandbox or change its network policy. `activeTools` and `inactiveTools` name entries
from the combined built-in + host set and are mutually exclusive — the settings type prevents
combining them, and `HarnessAgent` throws at runtime when both are given.

**`permissionMode` has three values**: `allow-all` (default), `allow-edits`, `allow-reads`. It
governs adapter-native built-in permissions only, and `allow-edits` / `allow-reads` only request
approval where the adapter supports built-in approvals — an adapter that supports neither native
filtering nor approval throws instead. Host tools are governed separately by `toolApproval`, whose
statuses are `not-applicable`, `approved`, `user-approval` and `denied`.

**Files reach the sandbox through hooks, not a mount option.** `sandboxConfig` takes `workDir`,
`bootstrapHash`, `onBootstrap({ session, abortSignal })` and
`onSession({ session, sessionWorkDir, abortSignal })`. `onBootstrap` runs during template creation,
after adapter bootstrap and before the snapshot is published, so its output is baked into a reusable
snapshot and `bootstrapHash` is what invalidates it. `onSession` runs after every session is
acquired, resumed ones included. The documented way to place a file is `writeTextFile` inside a hook.

**`instructions` is a single string**, appended to the system prompt where the adapter supports it
and otherwise prepended to the first user prompt.

**Durable workflows are already in the contract.** `@ai-sdk/workflow-harness` runs `HarnessAgent`
turns inside a workflow. `createHarnessWorkflowState()` opens the state; a `'use step'` function
calls either `runHarnessAgentStep()` (semantic agent steps, with the agent configured
`stopWhen: isStepCount(1)` so one `stream()` is one step) or `runHarnessAgentTimeSlice()`
(wall-clock slices, a 750-second budget by default, `timeSliceSeconds` to change it); the caller
re-schedules the step while `state.status === 'ready_for_next_step'`, and
`finalizeHarnessWorkflow()` returns the result or throws. Each step result carries `continueFrom`,
which continues the same unfinished turn in the next step. Across separate workflow runs the opaque
`resumeFrom` has to be persisted by the application, and a stable `sessionId` is what gives the
sandbox an identity that survives runs.

`@ai-sdk/tui` (`runAgentTUI`) renders an interactive terminal interface over a session; the page
frames it as developer-facing rather than production hosting.

### The Claude Code adapter's own settings (read 2026-08-27)

Source: [Claude Code adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code)

`createClaudeCode()` accepts `auth` (`'auto' | 'direct' | 'ai-gateway'`), `credentialForwarding`,
`mcpServers` (keyed by name; the server-definition schema is not given), `model`, `maxTurns`, `env`
(merged over the bridge process environment, taking precedence), `thinking` (`type` is
`'enabled' | 'disabled' | 'adaptive'`; `display` is `'summarized' | 'omitted'` and applies only to
`enabled` and `adaptive`, defaulting to adaptive/summarized), `port`, `startupTimeoutMs` and
`mintBridgeToken`.

Reading the shipped source rather than the page adds two the page omits: **`effort`**
(`'low' | 'medium' | 'high' | 'xhigh' | 'max'`, forwarded to the Agent SDK only when set) and
**`portEndpoint`**, required together with `port` when the sandbox session is a basic one that
cannot resolve its own ports.

The adapter is built on `@anthropic-ai/claude-agent-sdk` — not the Claude Code CLI — and installs
its bridge dependencies inside the sandbox when the first session begins, then talks to the host
over a sandbox-exposed WebSocket.

**What the adapter page does not document:** a `.claude` directory, a settings file, `CLAUDE.md`,
plugins, subagents, hooks, slash commands, settings-source selection, or allowed/disallowed tool
lists. None of these appear as adapter settings.

This looked load-bearing and uncomfortable, because the README argues that reusing the harness
brings its ecosystem along, and the adapter's *settings* do not carry any of it. The settings are
the wrong place to look: see the measurement below, which is what actually settles it.

### What the source says, and what a live run measured (2026-08-27)

The package ships its `src/`, so these are read from the implementation rather than the page.

**The bridge never passes `settingSources`.** `src/bridge/index.ts` builds its `claudeSdk.query()`
options without that key, and Agent SDK `0.3.213` documents the omitted default as *"all sources
are loaded (matches CLI defaults) ... Must include `'project'` to load CLAUDE.md files."* So the
session workdir's `.claude/` and `CLAUDE.md` are in scope by default.

**Measured, not inferred.** `packages/core/scripts/probe-claude-dir.ts` seeds a `CLAUDE.md`
carrying a unique codename and a `.claude/settings.json` declaring a `SessionStart` hook, then
runs one turn with **`activeTools: []`** — every built-in tool disabled, so the model cannot open
the file to answer. It replied with the codename verbatim, made **zero tool calls**, and the
hook's marker file existed afterwards. Two independent proofs: one the model could not have
obtained by reading, one it could not fabricate at all.

**So the honest split is narrower than "not in the contract".** Skills, the permission mode and
the adapter's own settings are one surface; the `.claude` directory the runtime reads at startup
is another, and the second is reachable through `onSession`. Hooks are the demonstrated case, and
permissions were later measured to cross the two — a seeded `deny` outranks `permissionMode` (see
the close of this page). Subagents (`.claude/agents/`), slash commands and plugins live in
that same directory. Skills, agents and commands were left unmeasured here and were settled
afterwards by the Agent SDK's own documentation instead — see below, and `examples/claude-code-docker`
invokes a seeded subagent. Plugins are the one that stays untested: the SDK has a `plugins` option
the adapter does not expose.

**Other details the page omits.** Skills do not stay inline: the adapter writes each one to
`$HOME/.claude/skills/<name>/SKILL.md` and then runs the query with `skills: 'all'`, because the
Agent SDK treats a `string[]` as an allowlist that would hide bundled defaults. `instructions`
becomes `systemPrompt: { type: 'preset', preset: 'claude_code', append }`. Structured output maps
to `outputFormat: { type: 'json_schema' }`. `permissionMode: 'allow-all'` with nothing filtered
becomes `bypassPermissions`. And the adapter **already occupies the `PostCompact` hook** itself,
to capture the compaction summary the `compact_boundary` message does not carry.

**What a sandbox has to provide.** The bootstrap recipe writes the bridge assets, runs
`pnpm install --frozen-lockfile --store-dir .pnpm-store`, then proves the install with
`./node_modules/.bin/claude --version` — installing `@anthropic-ai/claude-code` inside the
sandbox. The image therefore needs node >= 22, pnpm and registry egress. The bridge binds
`0.0.0.0`, takes its port from `BRIDGE_WS_PORT`, and is spawned as
`node <bootstrapDir>/bridge.mjs --workdir <workDir> --bridge-state-dir <dir>`. `@ai-sdk/sandbox-just-bash`
therefore **cannot** run it: it exposes no ports, which every bridged adapter needs.

**What this means for `please`:** the agent loop, the adapter contract, and structured output are
already someone else's problem. What is left is placement (which sandbox, which target), reach
(which channel), and sequencing (which workflow).

### What the Agent SDK itself loads from the filesystem (read 2026-08-28)

Sources:
[Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features),
[Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents),
[Extend agents with skills](https://code.claude.com/docs/en/agent-sdk/skills)

This is a layer below the adapter: what the Agent SDK does once the bridge has started it. It
matters because the adapter passes no `settingSources`, so the SDK's default is what a seeded
directory actually gets read as.

**The default is everything.** "When you omit `settingSources`, `query()` reads the same filesystem
settings as the Claude Code CLI: user, project, and local settings, CLAUDE.md files, and `.claude/`
skills, agents, and commands." Omitting it "is equivalent to `["user", "project", "local"]`". That
sentence covers the three things this repository had listed as unmeasured — skills, subagents and
commands — and is why no further probe was written for them.

**Where each source reads from**, with `<cwd>` the session's working directory:

| Input | Location |
| --- | --- |
| project `settings.json` and hooks | `<cwd>/.claude/` only — **no parent-directory fallback** |
| `CLAUDE.md`, `.claude/rules/*.md` | `<cwd>` and every parent directory |
| skills, commands, subagents | `<cwd>` and every parent up to the repository root, plus each `additionalDirectories` entry |
| `CLAUDE.md` in subdirectories | loaded on demand, when the agent reads a file in that subtree |

The first row is the one that constrains a framework: hooks and permission rules have to sit
directly under the session's own directory, while instructions and skills would still be found from
a parent. A layout that seeds them all to the same place is right for the wrong reason.

**Skills are files, not objects.** "Skills must be created as filesystem artifacts
(`.claude/skills/<name>/SKILL.md`). The SDK does not have a programmatic API for registering
skills." The `skills` option selects which discovered skills are enabled (`'all'`, a list of names,
or `[]`), it does not register them. This inverts what this repository previously recorded from the
AI SDK's own `skills` option: the inline-object form is the *adapter's* API, and the adapter
implements it by writing those objects to `$HOME/.claude/skills/<name>/SKILL.md` before querying.
Files are the native route; inline objects are a wrapper over it.

**Subagents work both ways.** Filesystem (`.claude/agents/*.md`) or the programmatic `agents`
option, with "programmatically defined agents take precedence over filesystem-based agents with the
same name". `Agent` has to be in `allowedTools` for invocations to auto-approve. The adapter
exposes no `agents` setting, so for a bridged run the filesystem is the only door.

One consequence of that door being the only one: since Claude Code v2.1.198 a subagent runs in the
**background by default**, and the only execution field a subagent *file* accepts is
`background: true`, which forces the same direction. A caller that needs the subagent's answer
inside the same turn cannot ask for it from the file form. `examples/claude-code-docker` shows both
halves — the `Agent` tool call appears in the turn, proving the seeded file was read as a
definition, and the verdict does not, because the run is still going when the turn ends.

**A watcher caveat that matters for seeding.** "the watcher covers only directories that existed
when the session started, so the first file in a new directory needs a session restart." Seeding
therefore has to complete before the session starts, which is what `onSession` guarantees — it runs
after the working directory exists and before the adapter starts. The 2026-08-27 hook measurement is
the evidence that the ordering holds in practice.

**What `settingSources` does not control**, and this is a deployment constraint rather than a
curiosity: managed policy settings, `~/.claude.json`, auto memory under
`~/.claude/projects/<project>/memory/`, and claude.ai MCP connectors are read regardless. The page
carries an explicit warning — "Do not rely on default `query()` options for multi-tenant isolation
… For multi-tenant deployments, run each tenant in its own filesystem". A container per session
satisfies that; a shared `$HOME` across tenants would not, and the adapter writes its own skills
into `$HOME`.

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
> subagents instead. eve documents extensions on a page of their own,
> [Extensions](https://eve.dev/docs/extensions), as npm packages that are installed and mounted and
> that contribute tools, skills, instructions, connections, channels, schedules, subagents and
> hooks. That page, not the integrations page, is the source to read before `agent/extensions/` is
> treated as the convention.

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
when the same agent is reachable from Slack, GitHub and Linear at once. The companion question — how
a bridged harness's sandbox lifetime is tied to a durable workflow's step boundaries — turned out not
to be open. `@ai-sdk/workflow-harness` defines the step boundary (`runHarnessAgentStep()` or
`runHarnessAgentTimeSlice()` inside a `'use step'` function), `continueFrom` carries an unfinished
turn between steps, and a stable `sessionId` plus an application-persisted `resumeFrom` carries a
session between runs. What is left is where that resume state lives per channel-originated request,
and whether a Cloudflare Workflow and a Vercel Workflow can run the same authored step.

The contract also opened questions the neighbours never had to answer. Host-executed `tools` run
wherever the application runs, so the same authored directory behaves differently on a Worker with a
per-invocation CPU limit than on a Node deployment with a real filesystem. Files reach the runtime by
three different routes with three different lifetimes — inline `skills`, per-session `onSession`
writes, and snapshot-baked `onBootstrap` output — so a layout that files them together hides which
is which.

The question that was open here — whether an adapter-native `.claude` directory means anything once
seeded — has since been **measured, and it does**. See "What the source says, and what a live run
measured" above. What that opened in turn — question 2 from
[`project-layout.md`](./project-layout.md), a seeded settings file and `permissionMode` describing
the same thing twice — is **measured too (2026-08-28): a seeded `deny` outranks `permissionMode`**.
A `{"permissions": {"deny": ["Bash", "Bash(*)"]}}` seeded into the session workdir blocked the bash
tool on both routes `permissionMode` takes into the SDK — the `bypassPermissions` fast path
included — while a control case with nothing seeded ran the same command. Two consequences for the
record: `permissionMode` is not the whole permission model, and a tool-wide `deny` removes the tool
outright (`No such tool available: Bash`) rather than gating its use. What a seeded `allow` or `ask`
does against the adapter's own settings was **not** measured, so this is one precedence case rather
than a general rule about which source wins.
`packages/core/scripts/probe-permissions.ts` is the measurement; question 2 there carries the
method and what it changes.
