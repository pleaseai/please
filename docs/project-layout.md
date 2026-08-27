# Project layout

> **Status: proposal, not a decision.** No layout below is implemented, no signature is settled, and
> `@pleaseai/core`'s root export is still empty. This note exists so the layout argument can be had
> against something concrete. Treat every directory below as a candidate.
>
> Open question 1 is the exception: it has been **answered by measurement**, and the sandbox layer
> written to answer it is real code (`@pleaseai/core/sandbox`). Everything the answer changed is
> marked below.

The facts this argument rests on are recorded with sources and dates in
[`prior-art.md`](./prior-art.md). Where the two disagree, `prior-art.md` is the record and this note
is the interpretation.

## The contract already answered the first question

The obvious first decision looked like a choice: keep harness-native assets in their own format, or
receive them in a neutral one and convert. That choice does not exist.

`skills` accepts inline objects only — `{ name, description, content, files?: [{ path, content }] }`.
No documented form takes a path or a directory. Anything handed to *that option* has to be read off
disk and built into those objects before the agent is constructed, so the question there is not
*whether* we build but *what we treat as the source format*: the `.claude/skills` shape, or one of
our own.

What has changed since this was written is that the option is no longer the only door. A
`.claude/skills/` directory seeded into the session workdir is in scope for the runtime by the same
mechanism that makes a seeded `CLAUDE.md` work — see open question 1. That turns a settled
constraint back into a choice between two routes.

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
| Skills | rebuilt as inline objects, or seeded as a directory — see open question 1 |
| Permission model | flattens to `allow-all` / `allow-edits` / `allow-reads` |
| Hooks | absent from the adapter's settings, but a seeded `.claude/settings.json` runs them — measured |
| Plugins, slash commands, subagents | absent from the adapter's settings; same directory as hooks, so likely reachable, unmeasured |

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
through configuration, which is what open question 1 settled; open question 2 is what the answer
left conflicting.

## Three routes, three lifetimes

Authored files reach the runtime by three different routes, at three different times, with three
different lifetimes:

| Authored | Route | Lives as long as |
| --- | --- | --- |
| bootstrap material | `onBootstrap`, once during template creation | the snapshot, until `bootstrapHash` changes |
| skills | built into `skills[]` before construction | the agent instance |
| skills, alternatively | `onSession` into `.claude/skills/` | the session |
| workspace files | `onSession` + `writeTextFile`, every session | the session |

Host-executed tools are a fourth case and not a route at all: they never enter the sandbox.

The `onSession` route carries more than plain workspace files. It is also how a `.claude/` directory
reaches the runtime, which is the only route any of the harness's directory-sourced features have —
and it is why skills appear twice in that table. The two rows are the same asset with different
lifetimes, and choosing between them is open question 1's leftover.

A layout that files these together hides which is which. Reading a directory should tell you when
its contents appear and how long they last.

## A layout that follows from that

```
src/
  app.ts             # required — server + routes (flue-style)
  agent.ts           # adapter + sandbox + instructions

  bootstrap/         # → onBootstrap. baked into the snapshot, invalidated by bootstrapHash
  skills/            # → skills[] or a seeded .claude/skills/ — route undecided, see question 1
  workspace/         # → onSession + writeTextFile. rewritten every session

  host-tools/        # → tools. runs on the host, not in the sandbox
  channels/          # slack.ts / github.ts / linear.ts (path is the name, eve-style)
  workflows/         # 'use step' wrappers over @ai-sdk/workflow-harness runners

  cloudflare.ts      # optional — target entrypoint
  vercel.ts          # optional
evals/               # beside src, not inside (eve-style)
```

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

## Open questions

**1. Does a seeded `.claude` directory mean anything? — ANSWERED: yes (2026-08-27).**
`packages/core/scripts/probe-claude-dir.ts` seeds a `CLAUDE.md` holding a unique codename and a
`.claude/settings.json` declaring a `SessionStart` hook, then runs one turn with `activeTools: []`
so no built-in tool can open the file. The model answered with the codename, made zero tool calls,
and the hook's marker file was there afterwards.

Two consequences. The `workspace/` route is not just for workspace files — it is the route for
everything the runtime reads out of a directory, which is why hooks moved rows in the table above.
And `skills/` no longer has to be built into inline objects to reach the runtime at all: a seeded
`.claude/skills/` is in scope for the same reason `CLAUDE.md` is. Two caveats keep that from being
settled. Only `CLAUDE.md` and a hook were measured; skills, subagents, slash commands and plugins
were not. And the adapter writes its own inline `skills` to `$HOME/.claude/skills/<name>/SKILL.md`
and queries with `skills: 'all'`, so a seeded project-level directory and the `skills` option would
be two sources for one thing — which is open question 2's problem, arriving a second time.

**2. Where do permissions come from?** This was a question about whether a seeded settings file
would be read; the answer to question 1 makes it a real conflict rather than a hypothetical one.
`permissionMode`'s three values and a seeded `.claude/settings.json` now demonstrably describe the
same thing twice. One of them has to win, and the answer decides whether the permission model can be
claimed as the harness's at all or stays something we flatten.

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
