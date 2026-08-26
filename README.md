# please

[![CI](https://github.com/pleaseai/please/actions/workflows/ci.yml/badge.svg)](https://github.com/pleaseai/please/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

English | [한국어](README.ko.md)

An agent framework, by [pleaseai](https://github.com/pleaseai).

## Status

**This repository is a scaffold.** It contains the toolchain, the license, the CI gates and an empty
`@pleaseai/core` package — nothing more.

The framework itself has not been designed. Its API, its feature set, its architecture, its
extension points and its scope are all **undecided**. Nothing in this repository should be read as a
commitment to any of them, and `packages/core/src/index.ts` deliberately exports nothing so that no
accidental surface can be quoted back as if it were settled.

What *is* settled:

- The name (`please`) and the org (`pleaseai`).
- That it is meant to become an agent framework.
- The license: Apache-2.0.
- The stack: [Bun](https://bun.sh), TypeScript, [Turborepo](https://turborepo.com).

Everything else is open. Design discussion belongs in issues.

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
  core/       # @pleaseai/core — placeholder; exports nothing yet
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md) and, for vulnerabilities, [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © Passion Factory
