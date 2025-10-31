import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workspaceRoot = resolve(__dirname, '..', '..');
const distRoot = resolve(workspaceRoot, 'dist');

export default defineConfig({
  build: {
    target: 'es2020',
  },
  server: {
    fs: {
      // Permit Vite to serve the locally linked @naylence/runtime build artifacts.
      allow: [workspaceRoot, distRoot],
    },
  },
});
