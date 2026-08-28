import pleaseai from '@pleaseai/eslint-config'

export default pleaseai(
  {
    // Example workspaces are fixtures seeded into a sandbox, not source. `sum.js` carries a
    // deliberate bug for the agent to find, and formatting it would be beside the point.
    ignores: ['examples/*/src/workspace/**'],
  },
  {
    // Tests belong in a package's `test/` directory, never inside `src/`.
    // Without this, a stray `src/**/*.test.ts` is silently indexed as production
    // code by SonarCloud (`sonar.sources` covers src; `sonar.tests` does not).
    name: 'pleaseai/tests-outside-src',
    files: ['packages/*/src/**/*.{test,spec,bench,test-d,spec-d}.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message: 'Tests belong in the package\'s test/ directory, not in src/.',
        },
      ],
    },
  },
)
