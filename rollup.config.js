import { defineConfig } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const windowsDrivePath = /^[A-Za-z]:[\\/]/u;

const markExternal = (id) => {
  if (
    id.startsWith('.') ||
    id.startsWith('/') ||
    id.startsWith('\0') ||
    windowsDrivePath.test(id) ||
    id.startsWith('dist/')
  ) {
    return false;
  }
  return true;
};

const browserPlugins = [
  resolve({ browser: true, preferBuiltins: false }),
  json(),
  commonjs(),
];

const nodePlugins = [
  resolve({ preferBuiltins: true }),
  json(),
  commonjs(),
];

export default defineConfig([
  {
    input: 'dist/esm/browser.js',
    output: [
      {
        file: 'dist/browser/index.mjs',
        format: 'es',
        sourcemap: false,
        inlineDynamicImports: true,
      },
      {
        file: 'dist/browser/index.cjs',
        format: 'cjs',
        sourcemap: false,
        exports: 'named',
        inlineDynamicImports: true,
      },
    ],
    external: markExternal,
    plugins: browserPlugins,
  },
  {
    input: 'dist/esm/index.js',
    output: [
      {
        file: 'dist/node/index.mjs',
        format: 'es',
        sourcemap: false,
        inlineDynamicImports: true,
      },
      {
        file: 'dist/node/index.cjs',
        format: 'cjs',
        sourcemap: false,
        exports: 'named',
        inlineDynamicImports: true,
      },
    ],
    external: markExternal,
    plugins: nodePlugins,
  },
  {
    input: 'dist/esm/node.js',
    treeshake: false,  // Disable tree-shaking for Node build to preserve storage registration
    output: [
      {
        file: 'dist/node/node.mjs',
        format: 'es',
        sourcemap: false,
        inlineDynamicImports: true,
      },
      {
        file: 'dist/node/node.cjs',
        format: 'cjs',
        sourcemap: false,
        exports: 'named',
        inlineDynamicImports: true,
      },
    ],
    external: markExternal,
    plugins: nodePlugins,
  },
]);
