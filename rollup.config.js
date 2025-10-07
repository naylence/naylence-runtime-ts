import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default defineConfig({
  input: 'src/browser.ts',
  output: {
    file: 'dist/browser/index.js',
    format: 'umd',
    name: 'NaylenceRuntime',
    sourcemap: true,
    inlineDynamicImports: true,
    globals: {
      'async_hooks': 'null',
      'pino': 'null',
      'pino-pretty': 'null',
      'fastify': 'null',
      '@fastify/websocket': 'null',
      'fs': 'null',
      'path': 'null',
      'util': 'null',
      'readline': 'null',
      'node:module': 'null',
      'node:fs': 'null',
      'node:fs/promises': 'null',
      'node:path': 'null',
      'node:crypto': 'null',
      'node:url': 'null'
    }
  },
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    json(),
    commonjs(),
    typescript({
      target: 'es2020',
      module: 'esnext',
      declaration: false,
      declarationMap: false,
      sourceMap: true,
      outDir: 'dist/browser',
    }),
  ],
  external: [
    'async_hooks',
    'pino',
    'pino-pretty',
    'fastify',
    '@fastify/websocket',
    'fs',
    'path',
    'util',
    'readline',
    'node:module',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:crypto',
    'node:url'
  ], // Mark Node.js modules as external
});
