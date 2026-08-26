# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`please` is intended to become an agent framework. **The repository is currently a scaffold: the
framework's public API, feature set, and architecture are not designed yet.** Do not invent them —
do not add exported types, classes, or functions to `@pleaseai/core` on the assumption that some
shape was agreed. If a task seems to require an API decision, surface the options and ask.

Workspaces:

- `packages/core` (`@pleaseai/core`) — the one package. `src/index.ts` intentionally exports nothing.

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
