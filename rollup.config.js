import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default defineConfig({
  input: 'src/index.ts',
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
      'fs': 'null'
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
      module: 'es2020',
      declaration: false,
      declarationMap: false,
      sourceMap: true,
    }),
  ],
  external: ['async_hooks', 'pino', 'pino-pretty', 'fastify', '@fastify/websocket', 'fs'], // Mark Node.js modules as external
});