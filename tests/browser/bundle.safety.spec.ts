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
  /^util(?:\.js)?$/i,
];

async function ensureNodeTypedArrays() {
  const { TextEncoder } = await import('node:util');
  const encoded = new TextEncoder().encode('');
  const prototypeCtor = Object.getPrototypeOf(encoded)?.constructor as typeof Uint8Array | undefined;
  if (prototypeCtor && prototypeCtor !== globalThis.Uint8Array) {
    (globalThis as unknown as { Uint8Array: typeof Uint8Array }).Uint8Array = prototypeCtor;
  }
}

const stubNodeUtil = {
  name: 'stub-node-util',
  setup(build: import('esbuild').PluginBuild) {
    build.onResolve({ filter: /^util$/ }, () => ({
      path: 'virtual:util',
      namespace: 'stub-util',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-util' }, () => ({
      contents: `export const TextEncoder = globalThis.TextEncoder;\nexport const TextDecoder = globalThis.TextDecoder;`,
      loader: 'js',
    }));
  },
} satisfies import('esbuild').Plugin;

describe('browser entry bundle safety', () => {
  it('bundles without pulling node builtins', async () => {
    await ensureNodeTypedArrays();
    const { build } = await import('esbuild');
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
      plugins: [stubNodeUtil],
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
