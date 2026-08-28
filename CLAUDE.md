# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`please` is intended to become an agent framework. **Only the declaration layer is designed; the
rest of the public API, the feature set, and the architecture are not.** `defineAgent` and
`defineSandbox` exist, and the reasoning behind them is in `docs/project-layout.md`. Everything
past them — channels, workflows, deploy targets, evals — is still open, so do not invent it: do
not add exported types, classes, or functions to `@pleaseai/core` on the assumption that some
shape was agreed. If a task seems to require an API decision, surface the options and ask.

Workspaces:

- `packages/core` (`@pleaseai/core`) — the one published package. The root export carries
  `defineAgent` and the workspace helpers; the sandbox layer lives behind `./sandbox/*` subpaths.
- `examples/*` — one private package per example, never published. They are type-checked with
  everything else, so an example that stops compiling against the core API fails CI.

**Tests live outside `src`.** Each package keeps its sources in `src/` and its tests in a
sibling `test/` directory — never colocated, never in a nested `__tests__/`. ESLint rejects a
test file placed under `src/`, so the rule is enforced rather than remembered. The type-check
covers both (`include: ["src", "test"]`), and SonarCloud's `sonar.sources` / `sonar.tests`
read the two directories directly, so the split is what keeps those sets disjoint.

## Package Manager

Always use **bun** instead of npm or pnpm, and **bunx** instead of npx or pnpm dlx.

```bash
bun install        # not: npm install / pnpm install
bun add <pkg>      # not: npm install <pkg> / pnpm add <pkg>
bun remove <pkg>   # not: npm uninstall / pnpm remove
bunx <cmd>         # not: npx <cmd> / pnpm dlx <cmd>
```

## Commands

Run commands from the repository root; use `turbo run <task> --filter=<package>` to scope one.

```bash
bun install         # install dependencies
bun run lint        # lint (lint:fix to auto-fix)
bun run type-check  # type-check all packages
bun run test        # run all tests
bun run build       # build all packages
mise run ci         # lint + type-check + test + build
```

## Code Style

ESLint uses `@pleaseai/eslint-config` (`eslint.config.ts`):

- 2-space indent, single quotes, no semicolons
- TypeScript strict mode

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/) (`@commitlint/config-conventional`):

```
<type>(<scope>): <subject>
```

**Types:** `feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `build` | `ci` | `chore` | `revert`

Rules: lowercase type, imperative mood (`add` not `added`), no trailing period, header ≤ 100 chars.

## Engineering Standards

- **File limit**: ≤ 500 LOC per source file; split by responsibility when exceeded
- **Function limit**: ≤ 50 LOC, ≤ 5 parameters (use parameter objects beyond that)
- **Surgical changes**: modify only what is requested — do not refactor surrounding code, restyle,
  or reformat untouched lines
- **No test manipulation**: never modify or delete tests to make code pass; fix the code instead
