# The dev TUI

> **Status: half decided, half blocked.** The boot chrome described below is implemented and
> tested in `@pleasedev/cli` (`packages/cli/src/ui`). The `dev` command it exists for is **not**,
> because the interactive UI needs two things from `defineAgent` that `defineAgent` does not
> expose yet. Those are named in [What the interactive UI needs](#what-the-interactive-ui-needs),
> and they are API decisions, not omissions to be quietly filled in.

Measurements below are against `@ai-sdk/tui@1.0.84` and `@ai-sdk/harness@1.0.91`, read on
2026-08-28 from the packages themselves rather than from the documentation.

## What `please dev` is

One command: take the agent this project declares, bring its sandbox up, and hand the running
session to an interactive terminal so a person can talk to it and watch what it does.

It is the smallest thing that makes the sandbox layer usable by a human rather than by a test.
Everything `please` has today is reachable only from a script — `examples/claude-code-docker`
drives exactly one turn with a prompt baked into the file — and a framework whose only interactive
surface is "edit the string and run it again" cannot be evaluated by the people it is for.

## Two UIs, two screens

The terminal work splits cleanly in two, and the split is not a matter of taste — it follows from
what each half does to the screen.

**The session is [`@ai-sdk/tui`](https://ai-sdk.dev/docs/ai-sdk-harnesses/terminal-ui)'s.**
`runAgentTUI` renders the transcript, markdown, tool sections, reasoning sections and manual tool
approvals, and runs until the user exits with `Esc` or `Ctrl+C`. It does this in the **alternate
screen buffer** — its bundle contains the `?1049h` / `?1049l` pair — so it takes the whole terminal
for the length of the session and gives it back untouched afterwards.

**Everything either side of that is ours**, and it belongs on the main screen. The banner naming
what is about to run, the phases of bringing a container up, and whatever is left behind when the
run ends all have to survive the alternate buffer being torn down. A failure that never reaches
the interactive UI has nothing to say from inside a buffer that was never entered.

That is why the reference for our half is
[eve's `cli/ui`](https://github.com/vercel/eve/tree/main/packages/eve/src/cli/ui) rather than
another TUI framework. eve's live region is built on the opposite premise from `@ai-sdk/tui`'s —
it deliberately streams into *native scrollback* so the user keeps real scrolling, copy/paste and
a transcript that outlives the process. Those two designs cannot be merged. They do not have to
be: they own different screens at different times.

So the port is small on purpose, and stops where `@ai-sdk/tui` starts:

| Ported from eve | Why | Not ported |
| --- | --- | --- |
| `output.ts` → `theme.ts`, `sanitize.ts` | palette, banner, aligned sections, escape-sequence removal | — |
| `terminal-text.ts` → `text.ts` | a Hangul glyph is two cells; a row measured with `.length` wraps, and a wrapped row breaks the repaint | word wrapping, cursor-column arithmetic — the editor's, not ours |
| `live-region.ts` | phases commit to scrollback while the current one animates | `clearAll`, bracketed paste — a REPL's, not a boot's |
| `progress-pulse.ts`, `live-row.ts` → `boot-row.ts` | the boot is long waits, not quick steps | — |
| — | — | `alt-screen.ts`: that buffer is `@ai-sdk/tui`'s |

The port also simplifies where the runtime has caught up: eve's hand-written table of zero-width
code points is replaced by the Unicode property escapes `\p{Mn}\p{Me}\p{Cf}`, and its shared
grapheme splitter by `Intl.Segmenter`, which Bun ships.

## Where it lives

A new workspace package, `@pleasedev/cli` (`packages/cli`), rather than a `@pleasedev/core` subpath.

`core`'s subpath rule exists to keep host-only code out of a bundle that cannot run it — the
docker backend spawns a CLI, so it sits behind `@pleasedev/core/sandbox/docker` and a Worker
bundling `@pleasedev/core` never pulls it in. A command-line program is not a subpath case of that
rule; it is the other side of it. It has a `bin`, it owns `process.stdout`, it reads a config file
off disk, and none of that is runtime-neutral in any sense the rule was written for.

The package is `private: true` for now. It has no command yet, and publishing an empty `please`
binary would be worse than not publishing one. Registration in `release-please-config.json` and
`.release-please-manifest.json` happens in the change that adds `dev`; `sonar-project.properties`
is updated already, because the source and tests exist and should be analysed.

## What the interactive UI needs

`runAgentTUI` takes an `AgentTUIAgent`. The shipped type is `Agent<any, any, any, any>` from `ai`,
which structurally requires `version`, `id`, `tools`, `generate` and `stream` — but the
implementation in 1.0.84 reads exactly two of them: **`agent.tools`** and **`agent.stream`**.

`HarnessAgent` already `implements Agent`, so it nearly fits. The one mismatch is the one the AI
SDK's own guide papers over with an adapter: `HarnessAgent.stream()` requires a `session` on every
call, and the terminal UI does not know about sessions. The documented workaround is a small
object that closes over one session for the lifetime of the run.

`defineAgent` does not currently expose the pieces that adapter needs:

1. **No `stream`.** `AgentSession.prompt()` returns a completed `AgentTurn` — it wraps
   `HarnessAgent.generate()`. The terminal UI cannot render a turn that only arrives once it is
   over; incremental rendering is the entire point of it.
2. **No `tools`.** `Agent` exposes `createSession` and nothing else. `runAgentTUI` reads
   `agent.tools` to render tool sections, and the merged builtin-plus-user tool set lives on the
   `HarnessAgent` that `defineAgent` builds and keeps to itself.
3. **No boot progress.** `createSession()` is a single opaque await covering the image pull, the
   container create, the definition's `onCreate`, the adapter's bootstrap inside the container
   (`pnpm install`, then the Claude Code CLI) and the session start. The example puts that at
   "roughly half a minute". The boot row can pulse through it, but it cannot *name* a phase it is
   not told about.

Three ways out, and this is the decision to make rather than to assume:

- **(a) Widen `AgentSession`** with `stream()` and surface `tools` on `Agent`. Keeps `defineAgent`
  the only entry point; grows the surface that the README still calls undesigned, and re-exports
  AI SDK stream types through it.
- **(b) Expose the underlying pair** — return the `HarnessAgent` and its `HarnessAgentSession`
  from `createSession`, and let the CLI build the adapter. Smallest addition, and honest about the
  fact that the harness boundary is the AI SDK's; leaks a type `defineAgent` otherwise hides.
- **(c) Let the CLI construct its own `HarnessAgent`** from the `AgentDefinition`, which
  `defineAgent` would export alongside the built agent. No new runtime surface at all; duplicates
  the sandbox-and-workspace wiring `defineAgent` exists to centralise, which is how the two drift.

(b) is the current preference — it adds one accessor rather than a parallel API, and the type it
leaks is one the project already refuses to wrap on principle. It is not decided.

For (3), the smallest honest answer is an optional `onProgress` on `createSession`, reporting the
phases the framework can already see. Anything finer than that is the adapter's to report, and it
does not.

## The boot sequence

What the main screen shows, before the alternate buffer opens:

```
please dev
==========
claude-code · docker · node:22-bookworm

[DOCKER] daemon reachable
▪ starting the container  please-dev-8f2c1a
```

The last line is the boot row: one line, pulsing, replaced as phases advance and committed to
scrollback when a phase finishes. Then `runAgentTUI` takes the screen. On exit the main screen
returns with those lines still on it, and the run adds its own closing section — session id,
what it cost, where the workspace ended up.

Three properties the row is built to hold, each pinned by a test:

- **One phase is one screen line.** Detail is fitted to the width that is left and ellipsized
  rather than allowed to wrap, measured in cells, so Korean and emoji do not silently wrap a row
  and desynchronise every later repaint.
- **A non-TTY gets prose.** Piped to a file or a CI log, the row degrades to one plain line per
  phase — and detail-only changes are dropped, because without a repaint each would be a line.
- **Nothing it prints is trusted.** Every value that came from another process — a container id,
  a docker progress line, an error — is stripped of escape sequences first. A stray cursor
  movement inside a row the engine did not write makes its row count a lie for the rest of the run.

## Open questions

1. **How does `dev` find the agent?** The example declares it as a default export from
   `src/agent.ts`. Convention (look for `agent.ts` near the working directory) or configuration
   (`--agent <path>`), and if convention, whose directory — the process's, or a project root
   located by walking up. Unanswered, and it is the same question
   [`project-layout.md`](./project-layout.md) leaves open about layout generally.
2. **What happens to the session on exit?** `Esc` ends the terminal UI; the sandbox behind it is
   still running. Destroying it is the safe default and throws away a warm container; `detach()`
   keeps it resumable and bills for it on a paid backend. The AI SDK's guide says one session per
   terminal run and to persist `detach()` state if you want to resume — which makes this a
   `please dev` policy question, not an SDK one.
3. **What is `contextSize`?** `runAgentTUI` shows usage against a context window only when told
   the number. No adapter reports it, so it is either a per-model table we maintain, a flag, or
   left off.
4. **Does the sandbox option apply?** `runAgentTUI({ sandbox })` forwards an
   `Experimental_SandboxSession` to *tool execution* in the host process. That is a different
   thing from the sandbox the harness runs inside, which reaches the agent as a
   `HarnessV1SandboxProvider`. Almost certainly left unset; worth stating so nobody wires the two
   together by name.

## Attribution

`@ai-sdk/tui` and eve are both Apache-2.0, as is this repository. The eve-derived files carry an
attribution header naming the file they came from, and `NOTICE` records the derivation.
