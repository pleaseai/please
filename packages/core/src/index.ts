/**
 * `@pleaseai/core` — the core package of the `please` agent framework.
 *
 * The framework's public surface has not been designed yet. Nothing here is a
 * placeholder for a decided API: this module exists so that the workspace,
 * build, type-check and test pipeline are real and exercised, and it
 * deliberately exports nothing that callers could mistake for a settled
 * contract.
 *
 * The accompanying test pins the emptiness on purpose — adding an export is a
 * design decision and should fail the suite until it is made deliberately.
 */

export {}
