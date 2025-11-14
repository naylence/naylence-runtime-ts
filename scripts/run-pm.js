#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [scriptName, ...restArgs] = process.argv.slice(2);

if (!scriptName) {
  console.error('Usage: node run-pm.js <script-name> [-- <args>...]');
  process.exit(1);
}

const pmExecPath = process.env.npm_execpath;

if (!pmExecPath) {
  console.error('Unable to determine package manager from npm_execpath.');
  process.exit(1);
}

const runArgs = [pmExecPath, 'run', scriptName];
if (restArgs.length > 0) {
  if (restArgs[0] === '--') {
    runArgs.push('--', ...restArgs.slice(1));
  } else {
    runArgs.push('--', ...restArgs);
  }
}

const result = spawnSync(process.execPath, runArgs, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
