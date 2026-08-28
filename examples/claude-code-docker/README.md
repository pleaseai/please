# claude-code-docker

Claude Code, running in a container on the local Docker daemon, fixing a bug in a file that was
seeded into its workspace.

```bash
bun run examples/claude-code-docker/index.ts
```

## What it needs

The example checks what it can before doing anything expensive — the Docker daemon and the
credential — and prints `SKIP` rather than failing when one is missing. Egress is not probed:
proving it means reaching the registry from inside the container, which costs the container
start that `SKIP` exists to avoid, so a missing one surfaces as a bootstrap failure instead.

- **A Linux-container Docker daemon** — Docker Desktop, OrbStack, or Colima.
- **An Anthropic credential** in `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. It is forwarded
  into the sandbox, where the agent runs. If the key belongs to a gateway rather than to
  Anthropic, set `ANTHROPIC_BASE_URL` too; the example otherwise pins the official endpoint,
  because a host-level gateway URL plus a Console key is a guaranteed 401.
- **Network egress from the container.** The Claude Code adapter bootstraps itself inside the
  sandbox — `pnpm install`, then the CLI — so the first session takes roughly half a minute.

One warning is expected during the run: *"credential brokering does not work. Falling back to
less secure credential forwarding."* It is accurate — the key is handed to the container rather
than brokered per request — and it is what the AI SDK does with any sandbox that does not
intercept the runtime's outbound requests.

Overrides: `EXAMPLE_IMAGE` (default `node:22-bookworm`), `EXAMPLE_MODEL` (default
`claude-sonnet-5`).

## Layout

```
index.ts            # drives one turn and reports it
src/
  agent.ts          # defineAgent — harness + sandbox + workspace
  sandbox.ts        # defineSandbox — the Docker backend and what prepares the container
  workspace/        # seeded into every session's working directory
    CLAUDE.md
    sum.js
    .claude/
      agents/
        verifier.md # a subagent, defined nowhere but here
```

Singular `agent.ts` and `sandbox.ts` because there is one of each. A deployment that needs a
different backend adds an entrypoint (`cloudflare.ts`) that builds the definition over one,
rather than a folder of alternatives to pick from.

## The part worth reading

`src/workspace/` is not a file drop. The Claude Agent SDK loads `CLAUDE.md`, `.claude/skills/`,
`.claude/agents/`, `.claude/commands/` and `.claude/settings.json` from the session's own working
directory — the bridge starts it without `settingSources`, and the omitted default reads user,
project and local sources alike.

The run shows both halves of that. The `CLAUDE.md` reaches the model's instructions, and the fix
keeps the file's semicolon-free style because the seeded conventions asked for it. And
`tools used` ends with **`Agent`** — the `verifier` subagent it invoked exists nowhere but in
`.claude/agents/verifier.md`, a file this example wrote into the container seconds earlier.

That is why `workspace` is a declared input on `defineAgent` rather than a hook you write: no
harness adapter exposes `agents`, `skills` or `settingSources`, so a directory is the only route
those features have into a run.

The verifier's *verdict* does not come back in the turn, and that is the runtime rather than a
shortcut here. Subagents run in the background by default, so the turn ends with the verification
still in flight, and the only execution field a subagent file accepts — `background: true` —
forces the same direction. Collecting the verdict needs a second turn against the same session,
which this example leaves out to stay one turn long.

`src/sandbox.ts` carries the other half — `onCreate`, which runs against the container *before*
the adapter bootstraps in it. The AI SDK has no hook that early, and this image needs one
(`corepack enable pnpm`).

## Expected output

```
session  starting the container and bootstrapping the runtime
workspace  /work/claude-code-<session id>
turn  asking the agent to fix sum.js

=== answer ===
The bug: the loop's stop condition was `i < numbers.length - 1`, which excludes the last index.
Changed it to `i < numbers.length` so the loop covers every element. The verifier agent is
running now to confirm; I'll report back once it finishes.

=== sum.js, as the agent left it ===
export function sum(numbers) {
  let total = 0
  for (let i = 0; i < numbers.length; i += 1) {
    total += numbers[i]
  }
  return total
}

tools used  read, edit, Agent
cleanup  session and container removed
```
