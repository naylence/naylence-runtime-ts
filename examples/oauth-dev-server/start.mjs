#!/usr/bin/env node
import { createApp } from '../../dist/esm/naylence/fame/http/oauth2-server.js';

// Provide friendly defaults while allowing overrides via environment variables.
process.env.FAME_JWT_CLIENT_ID = process.env.FAME_JWT_CLIENT_ID ?? 'demo-client';
process.env.FAME_JWT_CLIENT_SECRET =
  process.env.FAME_JWT_CLIENT_SECRET ?? 'demo-secret';
process.env.FAME_JWT_ALLOWED_SCOPES =
  process.env.FAME_JWT_ALLOWED_SCOPES ?? 'node.connect telemetry.read';
process.env.FAME_OAUTH_ENABLE_DEV_LOGIN =
  process.env.FAME_OAUTH_ENABLE_DEV_LOGIN ?? 'true';
process.env.FAME_OAUTH_DEV_USERNAME =
  process.env.FAME_OAUTH_DEV_USERNAME ?? 'devuser';
process.env.FAME_OAUTH_DEV_PASSWORD =
  process.env.FAME_OAUTH_DEV_PASSWORD ?? 'devpass';
process.env.FAME_OAUTH_SESSION_TTL_SEC =
  process.env.FAME_OAUTH_SESSION_TTL_SEC ?? '3600';
process.env.FAME_OAUTH_ALLOW_PUBLIC_CLIENTS =
  process.env.FAME_OAUTH_ALLOW_PUBLIC_CLIENTS ?? 'true';

const host = process.env.APP_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.APP_PORT ?? '8099', 10);

try {
  const app = await createApp();

  await app.listen({ port, host });

  const origin = `http://${host}:${port}`;
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.FAME_JWT_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    scope: 'node.connect',
    state: 'demo-state',
    code_challenge_method: 'S256',
    code_challenge: 'replace-with-real-challenge',
  });

  console.log('');
  console.log('[ready] OAuth dev server listening at %s', origin);
  console.log('  Client ID:     %s', process.env.FAME_JWT_CLIENT_ID);
  console.log('  Client Secret: %s', process.env.FAME_JWT_CLIENT_SECRET);
  console.log('  Allowed scope: %s', process.env.FAME_JWT_ALLOWED_SCOPES);
  console.log('  Login user:    %s', process.env.FAME_OAUTH_DEV_USERNAME);
  console.log('  Login pass:    %s', process.env.FAME_OAUTH_DEV_PASSWORD);
  console.log('');
  console.log('Sample authorize URL (replace challenge/state as needed):');
  console.log('  %s/oauth/authorize?%s', origin, authorizeParams.toString());
  console.log('');
} catch (error) {
  console.error('[error] Failed to start OAuth dev server:', error);
  process.exitCode = 1;
}
