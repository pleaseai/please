# Project layout

> **Status: partly decided, 2026-08-28.** The syntax question is settled and implemented —
> `defineAgent` and `defineSandbox` exist, `@pleasedev/core`'s root export is no longer empty, and
> `examples/claude-code-docker` runs on them. See [The syntax question](#the-syntax-question-and-why-it-is-defineagent).
>
> Open questions 1 and 2 are **answered by measurement**; what they turned on is now also
> **confirmed in the Agent SDK's own documentation**, which is why no third probe was written.
>
> Still a proposal: the directory list under [A layout that follows from
> that](#a-layout-that-follows-from-that) beyond `agent.ts`, `sandbox.ts` and `workspace/`, and
> open questions 3 and 4.

The facts this argument rests on are recorded with sources and dates in
[`prior-art.md`](./prior-art.md). Where the two disagree, `prior-art.md` is the record and this note
is the interpretation.

## The first question answered itself backwards

The obvious first decision looked like a choice: keep harness-native assets in their own format, or
receive them in a neutral one and convert. This note originally recorded that the choice did not
exist, because the AI SDK's `skills` option accepts inline objects only —
`{ name, description, content, files?: [{ path, content }] }`, no path and no directory — so
anything handed to *that option* had to be read off disk and rebuilt before construction.

That reading was right about the option and wrong about the runtime. The Agent SDK's own
documentation (read 2026-08-28) says the opposite of what the wrapper implies: **"Skills must be
created as filesystem artifacts (`.claude/skills/<name>/SKILL.md`). The SDK does not have a
programmatic API for registering skills."** The `skills` option selects which discovered skills are
enabled; it does not register any. And the adapter implements its inline form by *writing those
objects to disk* — `$HOME/.claude/skills/<name>/SKILL.md` — before querying.

So the direction is the reverse of the one assumed here. A directory is the native format, and the
inline object is a wrapper over it. Converting a `.claude/skills/` tree into inline objects would
be building a lossy encoder for a format the runtime already reads. The same sentence covers
`.claude/agents/` and `.claude/commands/`, which the adapter exposes no option for at all.

That is what makes `workspace` a declared input on `defineAgent` rather than a hook a user writes:
it is not a convenience over `onSession`, it is the only route these features have.

Two more shapes constrain the layout directly:

- **`tools` run in the host process**, not the sandbox. They can reach the sandbox through
  `experimental_sandbox`, but they execute where the application executes.
- **Files reach the sandbox only through hooks.** There is no mount option. `onBootstrap` runs during
  template creation and its output is baked into a reusable snapshot, invalidated by `bootstrapHash`;
  `onSession` runs for every session, resumed ones included, and the documented way to place a file
  is `writeTextFile`.

## What the harness actually brings along

The README argues that reusing the harness brings its ecosystem with it. Measured against the
contract as documented, that splits:

| | Verdict |
| --- | --- |
| Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `webSearch`) | comes along |
| Native conversation state and compaction | comes along |
| Session and resume (`detach()` / `stop()` → `sessionId` + `resumeFrom`) | comes along |
| Durable workflow stepping (`@ai-sdk/workflow-harness`) | comes along |
| Skills | comes along **as files** — `.claude/skills/` is the runtime's native format; the adapter's inline option is a wrapper that writes the same files |
| Permission model | three modes, but a seeded `.claude/settings.json` `deny` rule outranks all three — measured |
| Hooks | absent from the adapter's settings, but a seeded `.claude/settings.json` runs them — measured |
| Subagents, slash commands | absent from the adapter's settings; documented as loaded from a seeded `.claude/`, and a seeded subagent is invoked in `examples/claude-code-docker` |
| Plugins | absent from the adapter's settings; the SDK has a `plugins` option the adapter does not expose, so untested here |

`createClaudeCode()` takes `auth`, `credentialForwarding`, `mcpServers`, `model`, `maxTurns`, `env`,
`thinking`, `effort`, `port`, `portEndpoint`, `startupTimeoutMs` and `mintBridgeToken`, and is built
on `@anthropic-ai/claude-agent-sdk` rather than the CLI. No `.claude` directory, settings file,
`CLAUDE.md`, plugin, subagent, hook or slash-command option is among them.

That is a statement about the adapter's *settings*, and it is where this note previously stopped —
wrongly, because the settings are not the only way into the runtime. The bridge starts the Agent SDK
without passing `settingSources`, whose omitted default loads every source, so the session workdir's
own `.claude/` is read at startup. A probe confirmed it: see below.

This does not sink the premise — the parts that carry the most weight day to day, the tool set and
the session story, do come along. The README's claim has been narrowed to that set and now names
what does not follow. Some of the rest turned out to be winnable through the workspace rather than
through configuration, which is what open question 1 settled. The conflict it left behind —
permissions described in two places at once — is open question 2, and that is measured now too:
the seeded file wins.

## Three routes, three lifetimes

Authored files reach the runtime by three different routes, at three different times, with three
different lifetimes:

| Authored | Route | Lives as long as |
| --- | --- | --- |
| bootstrap material | `onBootstrap`, once during template creation | the snapshot, until `bootstrapHash` changes |
| workspace files, `.claude/` included | `onSession` + `writeTextFile`, every session | the session |
| skills, via the adapter | built into `skills[]`, which the adapter writes to `$HOME/.claude/skills/` | the session |

Host-executed tools are a fourth case and not a route at all: they never enter the sandbox.

Skills used to occupy two rows here, and choosing between them was open question 1's leftover. It
is not a choice between two formats any more, because both rows end as files on disk — the
difference is only *which* directory and who writes it. The workspace row is the one to author
against: it is project-level, it is the same route `CLAUDE.md`, hooks, subagents and commands
already take, and it is the row an existing Claude Code project already fits. The adapter row
remains useful for a skill computed at runtime, which has no directory to be read from.

A layout that files these together hides which is which. Reading a directory should tell you when
its contents appear and how long they last.

## A layout that follows from that

```text
src/
  agent.ts           # defineAgent — harness, sandbox, workspace, instructions   [implemented]
  sandbox.ts         # defineSandbox — backend, placement, onCreate / onSession  [implemented]
  workspace/         # → onSession + writeTextFile, every session                [implemented]
                     #   CLAUDE.md, .claude/{skills,agents,commands,settings.json}

  bootstrap/         # → onBootstrap. baked into the snapshot, invalidated by bootstrapHash
  host-tools/        # → tools. runs on the host, not in the sandbox
  channels/          # slack.ts / github.ts / linear.ts (path is the name, eve-style)
  workflows/         # 'use step' wrappers over @ai-sdk/workflow-harness runners

  app.ts             # server + routes, where there is a server (flue-style)
  cloudflare.ts      # optional — target entrypoint, and where a backend is chosen
  vercel.ts          # optional
evals/               # beside src, not inside (eve-style)
```

**`skills/` is gone from this list**, and its absence is the answer to the question the first
section asked. Skills are files the runtime reads from `.claude/skills/`, so they live inside
`workspace/` with everything else the runtime discovers by path. A top-level `skills/` would be a
second home for one thing, which is the outcome the README's "its ecosystem comes along" argument
exists to avoid.

**Singular file, not plural directory**, for `agent.ts` and `sandbox.ts`. There is one of each, and
a folder whose membership is permanently one is a folder that mislabels itself. The rule scales the
obvious way — `agents/` and `sandboxes/` when a project genuinely has several, and then both go
plural together rather than one of them drifting. flue's `sandboxes/daytona.ts` is not a
counterexample: it holds a *backend adapter*, the slot `@pleasedev/core/sandbox/docker` already
fills, not the configuration of one deployment.

**A second backend belongs to the entrypoint.** Local development runs Docker and production will
not; eve's advice to use the same backend everywhere is not available to us, because standing up a
Cloudflare sandbox locally costs more than the Docker backend exists to save. The split therefore
lands on `cloudflare.ts` building the definition over a different backend, not on a directory of
alternatives for `agent.ts` to choose between.

`host-tools/` rather than `tools/`, because the name is the only defence. Everything else in that
list describes the inside of the sandbox and this one does not, and the difference shows up as a
per-invocation CPU limit on a Worker.

One thing the list above does not place: external MCP servers. They are the contract's third tool
surface, configured on the adapter (`mcpServers`) rather than on the agent, and eve gives them a
directory of their own (`connections/`). Whether they are authored as files or stay adapter config
is undecided here.

Borrowed deliberately: eve's path-as-identity, which removes a whole class of drift between a
declared name and a file name; eve's `evals/` as a sibling rather than a child; flue's
single-resolution source directory and its optional per-target entrypoints.

Not borrowed: `tools/`, `skills/` and `subagents/` as *framework* concepts. flue and eve define
those because they own the agent loop. We do not, and defining them again would produce two of
everything — which is the cost the README's "its ecosystem comes along" argument exists to avoid.

## The syntax question, and why it is `defineAgent`

Decided 2026-08-28, between eve's `defineAgent({ … })` and flue's `'use agent'` directive with
hooks. The layout above is eve's lineage; so is the syntax, for three reasons that survived being
argued against.

**A directive needs a compiler, and we have two targets.** flue's `'use agent'` is resolved by a
Vite plugin. A framework that treats Cloudflare and Vercel as equally first-class would owe that
transform to both pipelines, and without it the source does not run at all. `defineAgent` is a
function call: it runs wherever the module does.

That cuts close to a transform this project *does* need — `workspace` is a path, and a Worker has
no filesystem, so a deploy has to inline the directory into the bundle. The two are not the same
obligation. Inlining turns one value into an asset and has a working fallback (read the path from
the host filesystem, which is what a local run does today); a directive rewrites the meaning of
every source file and has none. One is a deploy optimisation, the other a precondition.

**Hooks would re-do what the SDK already does.** `useTool` earns its place in flue because flue
owns the agent loop and the tool set is its own. Here the tool set is the harness's, and the one
thing a hook would still inject — a tool's execution context — arrives as an argument already:
`execute(args, { experimental_sandbox })`. Adding a hook context would mean two injections of the
same thing.

**Client tools outlive a render.** A tool without `execute` pauses the turn until something outside
submits its result, possibly in another process via `continueFrom`. A tool defined as a value is
re-loaded there by importing the same module; a hook's context is not something a second process
can re-enter.

What the decision explicitly does **not** include: wrapping the harness adapter.
`harness: createClaudeCode(…)` is imported from `@ai-sdk/harness-claude-code` and passed through.
A `@pleasedev/core/harness/claude-code` was drafted and withdrawn — it would buy nothing, and it
would turn "does Codex work" into a question about this package rather than about the AI SDK's
adapter contract.

One thing is genuinely new rather than borrowed: `defineSandbox({ onCreate })`, which runs against
the container *before* the adapter bootstraps in it. The AI SDK has no hook that early —
`onBootstrap` runs after the adapter's own bootstrap, `onSession` after the session exists — so
anything the adapter's first command depends on has nowhere to go. A backend that owns its
container can be earlier than the harness, and that is the one place this framework can act where
the AI SDK cannot.

## Open questions

**1. Does a seeded `.claude` directory mean anything? — ANSWERED: yes (2026-08-27).**
`packages/core/scripts/probe-claude-dir.ts` seeds a `CLAUDE.md` holding a unique codename and a
`.claude/settings.json` declaring a `SessionStart` hook, then runs one turn with `activeTools: []`
so no built-in tool can open the file. The model answered with the codename, made zero tool calls,
and the hook's marker file was there afterwards.

Two consequences. The `workspace/` route is not just for workspace files — it is the route for
everything the runtime reads out of a directory, which is why hooks moved rows in the table above.
And `skills/` no longer has to be built into inline objects to reach the runtime at all: a seeded
`.claude/skills/` is in scope for the same reason `CLAUDE.md` is.

The caveat this section used to carry — that only `CLAUDE.md` and a hook were measured, leaving
skills, subagents and commands as inference — was closed on 2026-08-28 by the Agent SDK's own
documentation rather than by a third probe: omitting `settingSources` "is equivalent to
`["user", "project", "local"]`", and those sources load "CLAUDE.md files, and `.claude/` skills,
agents, and commands". `examples/claude-code-docker` exercises the subagent half end to end — the
turn's `Agent` tool call comes from a `.claude/agents/verifier.md` that exists only in the seeded
workspace.

What the documentation adds, and a probe would not have found, is where each source reads from.
Project `settings.json` and hooks load from `<cwd>/.claude/` with **no parent-directory fallback**,
while `CLAUDE.md` is found from any parent and skills, commands and subagents from any parent up to
the repository root. Seeding everything to the session's own directory is therefore correct, but
only the first of those actually requires it.

**2. Where do permissions come from? — ANSWERED: a seeded `deny` outranks `permissionMode`
(2026-08-28).**
`permissionMode`'s three values and a seeded `.claude/settings.json` describe the same thing twice,
and question 1's answer made that a real conflict rather than a hypothetical one. The conflict is
now resolved by measurement: `packages/core/scripts/probe-permissions.ts` seeds
`{"permissions": {"deny": ["Bash", "Bash(*)"]}}` into the session workdir and asks the agent to run
`uname -r > marker` with the bash tool.

The rule is a `deny` on purpose. An `ask` cannot be read from outside — the adapter's `canUseTool`
auto-approves anything `allow-all` does not hold back, so an honoured `ask` and an ignored one look
identical. A `deny` has only two outcomes, and the marker's *content* separates them: it has to
carry the container's own `uname -r`, which the model cannot produce without executing something,
so a file written by any other tool is not counted.

`permissionMode` reaches the SDK by two different routes, so both were measured
(`@ai-sdk/harness-claude-code@1.0.94`, `src/bridge/index.ts:139-234`):

| Case | What the adapter sends | Seeded `deny` |
| --- | --- | --- |
| control — no rule seeded | `bypassPermissions` + `allowDangerouslySkipPermissions` | bash ran, marker matched |
| `allow-all`, every tool active | `bypassPermissions` + `allowDangerouslySkipPermissions`, **no** `settings` | **bound** |
| `allow-all`, one tool inactive | `permissionMode: 'default'` + an adapter-built `settings` object | **bound** |

So a seeded `deny` is not a second opinion the adapter can overrule — it outranks `permissionMode`
on both routes, including the one that asks the SDK to skip permissions entirely. And it does not
merely gate the call: the agent reported `No such tool available: Bash`, so a tool-wide `deny`
removes the tool from the set rather than denying its use.

**What this does not settle.** Only a `deny` was measured. Whether a seeded `allow` or `ask` can
widen what `permissionMode` grants is untested — and an `ask` is untestable from outside in the
first place, because the adapter's `canUseTool` auto-approves anything `allow-all` does not hold
back. So the reading is one precedence case, not a general rule that the file always wins.

Two consequences for this layout. The permission model is **not** something this framework flattens
to three modes — `permissionMode` is not the whole of it, and anything seeded under `workspace/` can
restrict beyond it, which puts permissions on the same route as `CLAUDE.md` and hooks rather than in
adapter settings. And the framework cannot claim `permissionMode` describes what an agent may do,
because a workspace it did not write can contradict it.

A constraint fell out of the same run, and it is a sandbox obligation rather than a layout one: the
bypass route **cannot start as root**. The CLI's gate is
`getuid() === 0 && IS_SANDBOX !== '1' && !CLAUDE_CODE_BUBBLEWRAP`, and the first run died on it
because `node:22-bookworm` runs as root. A container backend therefore either runs the harness as a
non-root user or declares `IS_SANDBOX=1`, and `@pleasedev/core/sandbox/docker` now declares it for
every container it creates — `containerEnv`, which the caller's own `env` can override. A container
*is* a deliberate sandbox, so the claim is true rather than a way around the check, and the probe
no longer sets it: the run is now also the check that the backend does.

The same constraint read from the other side is why `@pleasedev/core/sandbox/local` — a host-process
backend added since, for the cases where no daemon is reachable — deliberately does **not** declare
it. There the claim would be false, and the root check it defeats is the last thing standing between
a bypassed permission prompt and the developer's own home directory. Isolation is what makes the
declaration honest, so only the backend that provides isolation makes it.

`@pleasedev/core/sandbox/microsandbox` reads the constraint the same way the Docker backend does and
declares `IS_SANDBOX=1` for the same reason, with more room to spare: a microVM is a separate
kernel, so the claim is true by a wider margin than a container's. The caller still wins by passing
`IS_SANDBOX` in `env`.

`@pleasedev/core/sandbox/just-bash` — a virtual-shell backend added since, over an interpreter with
its own in-memory filesystem — sits outside this question rather than on either side of it. Its
isolation is real, but there is no `getuid()` to gate and no `node` to run: its commands are
interpreted, so the adapter's CLI cannot be launched inside it at all. It is a backend for the parts
of a workflow that are shell work, not for the part that is the agent.

**3. How does `host-tools/` behave across both targets?** A Worker has a per-invocation CPU limit; a
Node deployment has a real filesystem and owns its own restart reconciliation. The README says this
project absorbs that asymmetry rather than leaking it, and this is the first place that has to be
true.

**4. What is left for `workflows/` once `@ai-sdk/workflow-harness` is used?** The step boundary is
not ours to invent: `runHarnessAgentStep()` or `runHarnessAgentTimeSlice()` inside a `'use step'`
function, `continueFrom` continuing an unfinished turn between steps, and a stable `sessionId` plus
an application-persisted `resumeFrom` carrying a session between runs. What that package does *not*
decide is where the resume state lives per channel-originated request, or whether a Cloudflare
Workflow and a Vercel Workflow can run the same authored step — which is what `workflows/` would
have to be for. flue pushed workflows outside its framework entirely, so the precedent to read here
is the contract's own, not a neighbour's.
