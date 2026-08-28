import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/sandbox/index.ts',
    'src/sandbox/harness/index.ts',
    'src/sandbox/docker/index.ts',
    'src/sandbox/local/index.ts',
    'src/sandbox/just-bash/index.ts',
    'src/sandbox/microsandbox/index.ts',
  ],
  format: ['esm'],
  // tsup injects a deprecated `baseUrl` into the dts build; silence it under TS 6
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
})
