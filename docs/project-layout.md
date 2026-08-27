# Project layout

> **Status: proposal, not a decision.** Nothing here is implemented, no signature is settled, and
> `@pleaseai/core` still exports nothing. This note exists so the layout argument can be had against
> something concrete. Treat every directory below as a candidate, and the open questions at the end
> as genuinely open.

The facts this argument rests on are recorded with sources and dates in
[`prior-art.md`](./prior-art.md). Where the two disagree, `prior-art.md` is the record and this note
is the interpretation.

## The contract already answered the first question

The obvious first decision looked like a choice: keep harness-native assets in their own format, or
receive them in a neutral one and convert. That choice does not exist.

`skills` accepts inline objects only — `{ name, description, content, files?: [{ path, content }] }`.
No documented form takes a path or a directory. Anything authored on disk has to be read and built
into those objects before the agent is constructed. The remaining question is not *whether* we
build, but *what we treat as the source format*: the `.claude/skills` shape, or one of our own.

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
| Skills | must be rebuilt as inline objects |
| Permission model | flattens to `allow-all` / `allow-edits` / `allow-reads` |
| Plugins, slash commands, hooks, subagents | not in the contract at all |

`createClaudeCode()` takes `auth`, `credentialForwarding`, `mcpServers`, `model`, `maxTurns`, `env`,
`thinking`, `port`, `startupTimeoutMs` and `mintBridgeToken`, and is built on
`@anthropic-ai/claude-agent-sdk` rather than the CLI. No `.claude` directory, settings file,
`CLAUDE.md`, plugin, subagent, hook or slash-command option is documented.

This does not sink the premise — the parts that carry the most weight day to day, the tool set and
the session story, do come along. The README's claim has been narrowed to that set and now names
what does not follow. Whether any of the rest can be won back is what open questions 1 and 2
decide.

## Three routes, three lifetimes

Authored files reach the runtime by three different routes, at three different times, with three
different lifetimes:

| Authored | Route | Lives as long as |
| --- | --- | --- |
| bootstrap material | `onBootstrap`, once during template creation | the snapshot, until `bootstrapHash` changes |
| skills | built into `skills[]` before construction | the agent instance |
| workspace files | `onSession` + `writeTextFile`, every session | the session |

Host-executed tools are a fourth case and not a route at all: they never enter the sandbox.

A layout that files these together hides which is which. Reading a directory should tell you when
its contents appear and how long they last.

## A layout that follows from that

```
src/
  app.ts             # required — server + routes (flue-style)
  agent.ts           # adapter + sandbox + instructions

  bootstrap/         # → onBootstrap. baked into the snapshot, invalidated by bootstrapHash
  skills/            # → built into skills[]. sourced from the .claude/skills shape
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

**1. Does a seeded `.claude` directory mean anything?** The adapter does not accept one as
configuration, but `onSession` can write one into the workspace, and whether the Agent SDK reads it
is not documented either way. If it does, the source format for `skills/` and the permission story
are settled together. This is a package-level experiment rather than a design debate, and the other
three questions are easier to answer once it is done.

**2. Where do permissions come from?** `permissionMode`'s three values and a seeded settings file
would describe the same thing twice. One of them has to win, and the answer decides whether the
permission model can be claimed as the harness's at all or stays something we flatten.

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
