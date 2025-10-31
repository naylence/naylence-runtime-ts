import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

const FORBIDDEN_PATTERNS = [
  /^node:/i,
  /node_modules\/(?:@)?fastify\//i,
  /node_modules\/better-sqlite3\//i,
  /node_modules\/express(?:\/.+)?$/i,
  /node_modules\/pino(?:\/.+)?$/i,
  /node_modules\/pino-pretty(?:\/.+)?$/i,
  /node_modules\/ws\//i,
];

describe('browser entry bundle safety', () => {
  it('bundles without pulling node builtins', async () => {
    const result = await build({
      entryPoints: [resolve(process.cwd(), 'src/browser.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      mainFields: ['browser', 'module', 'main'],
      logLevel: 'silent',
      treeShaking: true,
      target: 'es2020',
      conditions: ['browser', 'module'],
      define: {
        'process.env.NODE_ENV': '"test"',
      },
    });

    const inputs = Object.keys(result.metafile?.inputs ?? {});
    const activeInputs = inputs.filter(
      (specifier) => !specifier.startsWith('(disabled):')
    );
    const forbidden = activeInputs.filter((specifier) => {
      return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier));
    });

    expect(forbidden).toHaveLength(0);
  });
});
