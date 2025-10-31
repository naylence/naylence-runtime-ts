import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/browser/**/*.spec.ts'],
    setupFiles: ['test/setup-crypto.ts', 'test/setup-idb.ts'],
    globals: true,
    deps: {
      optimizer: {
        web: {
          include: ['@naylence/runtime'],
        },
      },
    },
    environmentMatchGlobs: [
      ['tests/browser/bundle.safety.spec.ts', 'node'],
    ],
  },
  resolve: {
    alias: [
      {
        find: /^@naylence\/runtime\/browser$/,
        replacement: resolve(__dirname, 'src/browser.ts'),
      },
      {
        find: /^@naylence\/runtime$/,
        replacement: resolve(__dirname, 'src/index.ts'),
      },
    ],
  },
});
