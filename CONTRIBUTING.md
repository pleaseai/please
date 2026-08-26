# Contributing

Thanks for your interest in contributing! This guide covers how to get from a clone to a merged pull request.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). All documentation, code, comments, and commit messages in this repository are written in **English**.

> **Note:** This repository is currently a scaffold. The framework's API, feature set, and architecture have not been designed yet — see the [Status](./README.md#status) section of the README. Design discussion belongs in [Discussions](https://github.com/pleaseai/please/discussions/categories/ideas), not in speculative code.

## Getting started

```bash
git clone https://github.com/pleaseai/please.git
cd please
mise install        # install pinned tool versions (bun)
bun install         # install dependencies
```

If you do not use [mise](https://mise.jdx.dev), any recent bun works — install it, then run `bun install`.

The package manager is **bun**, never npm or pnpm; use `bunx`, never `npx`.

## Development workflow

1. Create a branch from `main` (e.g. `feat/short-description` or `fix/issue-123`).
2. Make focused changes — keep each pull request to one logical change.
3. Run the checks below and make sure they pass.
4. Open a pull request and fill out the template.

```bash
bun run lint        # lint and format (use lint:fix to auto-fix)
bun run type-check  # type-check all packages
bun run test        # run the test suite
bun run build       # ensure it builds

mise run ci         # or run lint + type-check + test + build in one step
```

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, where `type` is one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, etc. Breaking changes include a `BREAKING CHANGE:` footer. Versioning and the changelog are generated automatically from these messages (via release-please), so accurate types matter.

The header is lowercase, imperative mood, no trailing period, and at most 100 characters. `commitlint` enforces this on commit.

## Pull requests

- Reference the issue your PR addresses (e.g. `Closes #123`).
- Use a Conventional-Commit-style PR title — it becomes the squash-merge commit.
- Make sure CI is green before requesting review.

## Reporting bugs and requesting features

Bugs go to [Issues](https://github.com/pleaseai/please/issues); feature requests, ideas, and questions go to [Discussions](https://github.com/pleaseai/please/discussions). For security vulnerabilities, **do not** open a public issue — follow [SECURITY.md](./SECURITY.md).
