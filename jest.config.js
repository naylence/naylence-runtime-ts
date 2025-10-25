/** @type {import('ts-jest').JestConfigWithTsJest} */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check if we're in a local dev environment with sibling repos
const hasLocalCore = existsSync(resolve(__dirname, '../naylence-core-ts/dist/cjs/index.js'));
const hasLocalFactory = existsSync(resolve(__dirname, '../naylence-factory-ts/dist/cjs/index.js'));

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: [
    '<rootDir>/src',
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Use local builds in dev, node_modules in CI
    '^@naylence/core$': hasLocalCore 
      ? '<rootDir>/../naylence-core-ts/dist/cjs/index.js'
      : '<rootDir>/node_modules/@naylence/core/dist/cjs/index.js',
    '^naylence-core$': hasLocalCore
      ? '<rootDir>/../naylence-core-ts/dist/cjs/index.js'
      : '<rootDir>/node_modules/@naylence/core/dist/cjs/index.js',
    '^naylence-core-ts$': hasLocalCore
      ? '<rootDir>/../naylence-core-ts/dist/cjs/index.js'
      : '<rootDir>/node_modules/@naylence/core/dist/cjs/index.js',
    '^@naylence/factory$': hasLocalFactory
      ? '<rootDir>/../naylence-factory-ts/dist/cjs/index.js'
      : '<rootDir>/node_modules/@naylence/factory/dist/cjs/index.js',
    '^naylence-factory$': hasLocalFactory
      ? '<rootDir>/../naylence-factory-ts/dist/cjs/index.js'
      : '<rootDir>/node_modules/@naylence/factory/dist/cjs/index.js',
    '^naylence-factory-ts$': hasLocalFactory
      ? '<rootDir>/../naylence-factory-ts/dist/cjs/index.js'
      : '<rootDir>/node_modules/@naylence/factory/dist/cjs/index.js',
    '^@naylence/runtime$': '<rootDir>/dist/cjs/index.js',
    '^naylence-runtime$': '<rootDir>/dist/cjs/index.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|yaml|jose|@peculiar)/)',
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
