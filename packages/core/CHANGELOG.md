# Changelog

## 0.1.0 (2026-08-29)


### ⚠ BREAKING CHANGES

* **core:** `readWorkspace` returns `{ files, skipped }` rather than `WorkspaceFiles`. Reporting a skipped file has to mean something the caller can observe, and this package has no logger to write it to.

### Features

* **core:** add a docker sandbox backend and measure the seeded .claude directory ([#7](https://github.com/pleaseai/please/issues/7)) ([e245fc1](https://github.com/pleaseai/please/commit/e245fc18d76b67958a815e6a007628a3f9ecaa85))
* **core:** add defineAgent and defineSandbox as the first public API ([#13](https://github.com/pleaseai/please/issues/13)) ([7948fc1](https://github.com/pleaseai/please/commit/7948fc1f70afd4cf41a1378e4d201ca7bc443366))
* **core:** add three sandbox backends and move SandboxFileNotFoundError onto the contract ([#12](https://github.com/pleaseai/please/issues/12)) ([0a33a6b](https://github.com/pleaseai/please/commit/0a33a6b732d3e99e933a3156c0aacc1b70d567a2))
* **core:** probe where permissions come from and declare IS_SANDBOX in the docker backend ([#11](https://github.com/pleaseai/please/issues/11)) ([ee9884b](https://github.com/pleaseai/please/commit/ee9884ba4ad3ef574c0e12ea8b83235133236f5d))


### Bug Fixes

* **core:** give readWorkspace ignore rules, size caps and a skip report ([#24](https://github.com/pleaseai/please/issues/24)) ([e6bf482](https://github.com/pleaseai/please/commit/e6bf4823c0801fcb576863aae4b947c8ff56faa8))
* **core:** remove only a container the handle created ([#25](https://github.com/pleaseai/please/issues/25)) ([cdd91d0](https://github.com/pleaseai/please/commit/cdd91d0f5c1d45f0abcae78eaae8988b002c5fb0))
