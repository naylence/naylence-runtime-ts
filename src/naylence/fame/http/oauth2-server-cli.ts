#!/usr/bin/env node
/**
 * CLI entry point for OAuth2 server
 * This file is ESM-only and auto-executes when run directly
 */

import { main } from './oauth2-server.js';

main().catch((error: Error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
