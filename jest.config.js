/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: [
    '<rootDir>/src',
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^naylence-core$': '<rootDir>/../naylence-core-ts/dist/cjs/index.js',
    '^naylence-core-ts$': '<rootDir>/../naylence-core-ts/dist/cjs/index.js',
    '^naylence-factory$': '<rootDir>/../naylence-factory-ts/dist/cjs/index.js',
    '^naylence-factory-ts$': '<rootDir>/../naylence-factory-ts/dist/cjs/index.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|yaml|jose)/)',
  ],
  transform: {
    '^.+\\.(ts|js|mjs)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'node',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          isolatedModules: true,
          sourceMap: true,
          inlineSources: true,
          inlineSourceMap: false, // Use separate source maps for better debugging
        },
        diagnostics: {
          ignoreCodes: [151001],
        },
      },
    ],
  },
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/*.test.ts',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  maxWorkers: 1, // Sequential execution to prevent race conditions
  testTimeout: 10000,
  setupFilesAfterEnv: [
    '<rootDir>/test/setup-crypto.ts',
    '<rootDir>/test/setup-idb.ts',
    '<rootDir>/test/setup-runtime.ts',
  ],
};
