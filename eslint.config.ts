import pleaseai from '@pleaseai/eslint-config'

export default pleaseai(
  {},
  {
    // Tests belong in a package's `test/` directory, never inside `src/`.
    // Without this, a stray `src/**/*.test.ts` is silently indexed as production
    // code by SonarCloud (`sonar.sources` covers src; `sonar.tests` does not).
    name: 'pleaseai/tests-outside-src',
    files: ['packages/*/src/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}'],
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
