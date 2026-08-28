# please

[![CI](https://github.com/pleaseai/please/actions/workflows/ci.yml/badge.svg)](https://github.com/pleaseai/please/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

English | [한국어](README.ko.md)

An agent framework that **does not write its own agent loop**.

`please` runs an existing coding-agent harness — Claude Code, OpenCode, Pi — as its runtime, and
supplies the things a harness has no opinion about: where it executes, how it is reached, and how
work is sequenced so it survives a crash.

## Why reuse a harness

Frameworks in this space ([eve](https://eve.dev), [flue](https://flueframework.com)) drive a model
directly and rebuild the surrounding agent: the tool set, the permission prompts, the session and
resume story, the compaction. That is the part of a coding agent that is already good, already
maintained upstream, and already familiar to the people who would use this. A reimplementation is a
worse copy carrying a permanent obligation to chase the original.

Two things follow from reusing the harness instead:

- **Much of its ecosystem comes along.** The built-in tools, the native conversation state and
  compaction, the session and resume story, and durable workflow stepping are the harness's, not
  ours to re-earn.
- **It decides the bill.** Driving Claude Code as a harness runs on a Claude Code subscription. A
  hand-rolled loop against the Messages API bills per token for the same work.

What does *not* come along is on the record too: skills have to be handed over as inline objects
rather than read from a directory. The adapter's *settings* also carry no hooks and only three
permission modes — but the settings are not the only way in. A `.claude/settings.json` seeded into
the session workdir is read, and live probes measured both consequences: a hook declared there
runs, and a `deny` rule there overrides the adapter's permission mode, including the mode that asks
the runtime to skip permission checks altogether. See
[`docs/project-layout.md`](docs/project-layout.md).

The harness boundary itself is not ours either — it is the AI SDK's
[harness agent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent) and
[harness adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters) contract, which
already normalizes sessions, streamed events, tools, usage and lifecycle across runtimes. `please`
is what you build *around* a `HarnessAgent`, not a competitor to it.

## Scope

This is the **scope**, not an API. Nothing below is implemented and no signature is settled — see
[Status](#status).

| Axis | Planned |
| --- | --- |
| **Harnesses** | Claude Code, OpenCode (both sandbox-bridged), Pi (host process) — via `@ai-sdk/harness` |
| **Deploy targets** | Cloudflare, Vercel |
| **Sandboxes** | Cloudflare Sandbox, [e2b](https://e2b.dev), [Daytona](https://daytona.io), Vercel Sandbox |
| **Channels** | Slack, GitHub, Linear |
| **Workflows** | Durable orchestration around agent turns — dispatch, resume, sequence |

Four notes on why the axes are drawn there:

**Harnesses.** The AI SDK's adapter list is broader (Codex, Cursor, Cline, Deep Agents, fx, Grok
Build, with Amp, Goose and Mastra listed as upcoming). Three is the starting set, not the ceiling;
the contract is per-adapter, so more is a matter of testing rather than architecture. Claude Code
and OpenCode run behind a sandbox bridge and therefore need a network-capable sandbox; Pi runs in
the host process and does not.

**Targets.** Cloudflare and Vercel are both first-class rather than one plus a port. They fail
differently — a Worker gets platform-managed recovery and a per-invocation CPU limit; a Node-shaped
deployment gets a real filesystem and owns its own restart reconciliation — and a framework that
treats one as the real target and the other as an afterthought leaks that asymmetry into every
feature.

**Sandboxes.** Four providers, because a bridged harness needs a sandbox that can run real
processes and expose a port, and that requirement is exactly where providers differ. The point of
having a sandbox contract at all is that this choice stays a deployment decision.

**Channels.** Slack, GitHub and Linear — where work is actually assigned, rather than a chat
surface bolted on afterwards. Their inbound shapes differ enough (a signed webhook, an event
stream, a socket) that pretending they are one thing is how the abstraction goes wrong.

## Status

**The framework API is still undesigned.** `@pleasedev/core`'s root export is deliberately empty,
so no accidental surface can be quoted back as if it were settled.

One layer does exist, because it was the layer the open questions could not be answered without: the
**sandbox**. It is reached through its own subpath exports, never the root.

| Subpath | What it is |
| --- | --- |
| `@pleasedev/core/sandbox` | the backend contract — vendor-neutral types |
| `@pleasedev/core/sandbox/harness` | the contract rendered as AI SDK `HarnessV1SandboxProvider`, written once for every backend |
| `@pleasedev/core/sandbox/docker` | a local Docker backend. **Host-only** — it spawns the `docker` CLI, so it must never reach a Worker bundle |
| `@pleasedev/core/sandbox/local` | a host-process backend — no daemon, no image, **and no isolation**. Host-only for the same reason |
| `@pleasedev/core/sandbox/just-bash` | a virtual-shell backend over [`just-bash`](https://www.npmjs.com/package/just-bash) — no daemon, no image, no host process, and **no real binaries**. `just-bash` is an optional peer dependency |
| `@pleasedev/core/sandbox/microsandbox` | a microVM backend over [`microsandbox`](https://www.npmjs.com/package/microsandbox) — isolation by hypervisor rather than by namespace. Optional peer dependency; **type-checked but not yet run** (see below) |

Splitting the harness translation from the backends is what keeps a second backend from re-deriving
it, and the subpaths are what keep host-only code out of a target that cannot run it.

Three of the four backends are covered by suites that run wherever their prerequisite is present —
`local` and `just-bash` everywhere, `docker` where a daemon is reachable. The **microsandbox**
backend is the exception and says so rather than implying otherwise: `microsandbox` ships no native
addon for `darwin-x64`, which is the platform it was written on, so its behavioural suite has never
been observed to pass. What *is* checked everywhere is that its structural copies of the vendor's
types still match the vendor's own declarations — `test/sandbox/microsandbox/vendor-shape.test.ts`,
enforced by `tsc`.

Decided: the scope table above, the name, the license (Apache-2.0), the stack
([Bun](https://bun.sh), TypeScript, [Turborepo](https://turborepo.com)), and the sandbox split
described above.

Undecided: **the rest of the API**. How an agent is declared, whether the project layout is
convention- or config-driven, how a workflow is expressed, what a channel handler receives, how
evals are written. Design discussion belongs in
[Discussions](https://github.com/pleaseai/please/discussions/categories/ideas); issues are for bugs.

## Requirements

- [Bun](https://bun.sh) — the version is pinned in [`mise.toml`](mise.toml).
- Optionally [mise](https://mise.jdx.dev), which installs that pinned version for you.

## Getting started

```bash
git clone https://github.com/pleaseai/please.git
cd please

mise install   # install the pinned bun version (skip if you manage bun yourself)
bun install    # install dependencies
```

## Commands

```bash
bun run lint        # lint (bun run lint:fix to auto-fix)
bun run type-check  # type-check all packages
bun run test        # run the test suite
bun run build       # build all packages

mise run ci         # lint + type-check + test + build
```

## Layout

```
packages/
  core/                      # @pleasedev/core — root export is deliberately empty
    src/sandbox/
      contract/              # the backend contract
      harness/               # HarnessV1SandboxProvider over that contract
      docker/                # local Docker backend (host-only)
      local/                 # host-process backend (host-only, unisolated)
      just-bash/             # virtual-shell backend (no host process, no real binaries)
      microsandbox/          # microVM backend (host-only, hypervisor-isolated)
    scripts/                 # probes that measure the runtime rather than assume it
docs/
  prior-art.md               # what eve, flue and the AI SDK harnesses already do
  project-layout.md          # a proposed layout, and the open questions it waits on
```

The three probes under `packages/core/scripts/` are runnable, and each answers a question the docs
would otherwise have to guess at:

```bash
bun run packages/core/scripts/probe-adapter-bootstrap.ts  # no credentials needed
bun run packages/core/scripts/probe-claude-dir.ts         # needs an Anthropic credential
bun run packages/core/scripts/probe-permissions.ts        # needs an Anthropic credential
```

## Prior art

[`docs/prior-art.md`](docs/prior-art.md) records what eve, flue and the AI SDK harness contract
actually do — read from their own documentation, with dates — so that design arguments here start
from what exists rather than from recollection.

[`docs/project-layout.md`](docs/project-layout.md) is the first argument built on that record: a
proposed layout, what the contract already decides for us, and the questions still open.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md) and, for vulnerabilities, [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © Passion Factory
