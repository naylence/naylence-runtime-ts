#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';

const origin = process.env.OAUTH_ORIGIN ?? 'http://127.0.0.1:8099';
const clientId = process.env.OAUTH_CLIENT_ID ?? 'demo-client';
const redirectUri =
  process.env.OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:9876/callback';
const scope = process.env.OAUTH_SCOPE ?? 'node.connect';
const username = process.env.OAUTH_DEV_USERNAME ?? 'devuser';
const password = process.env.OAUTH_DEV_PASSWORD ?? 'devpass';

const cookieJar = new Map();

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(segment) {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64');
}

function generateVerifier() {
  // 64 characters after encoding keeps us inside the 43-128 PKCE range.
  return base64Url(randomBytes(48));
}

function computeS256(verifier) {
  return base64Url(createHash('sha256').update(verifier, 'utf8').digest());
}

function storeCookies(response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const headerValues = getSetCookie
    ? getSetCookie()
    : response.headers.raw?.()['set-cookie'] ?? [];

  for (const entry of headerValues) {
    const [cookiePair] = entry.split(';');
    if (!cookiePair) {
      continue;
    }
    const [name, value] = cookiePair.split('=');
    if (!name) {
      continue;
    }
    cookieJar.set(name.trim(), value ? value.trim() : '');
  }
}

function cookieHeader() {
  if (cookieJar.size === 0) {
    return undefined;
  }
  return Array.from(cookieJar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function createRequestHeaders(extra = {}) {
  const headers = { ...extra };
  const cookie = cookieHeader();
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

function ensureStatus(response, expected, context) {
  if (response.status !== expected) {
    throw new Error(
      `${context} expected HTTP ${expected} but received ${response.status}`
    );
  }
}

const verifier = generateVerifier();
const challenge = computeS256(verifier);
const state = base64Url(randomBytes(24));

const authorizeUrl = new URL('/oauth/authorize', origin);
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  scope,
  state,
  code_challenge_method: 'S256',
  code_challenge: challenge,
}).toString();

console.log('[client] Starting PKCE authorization flow against %s', origin);

const authorizeResponse = await fetch(authorizeUrl, {
  redirect: 'manual',
  headers: createRequestHeaders(),
});
storeCookies(authorizeResponse);
ensureStatus(authorizeResponse, 302, 'Authorize redirect');

const loginLocation = authorizeResponse.headers.get('location');
if (!loginLocation) {
  throw new Error('Authorize response did not include a Location header');
}

const loginUrl = new URL(loginLocation, origin);
const returnTo = loginUrl.searchParams.get('return_to');
if (!returnTo) {
  throw new Error('Login redirect did not include return_to parameter');
}

console.log('[client] Redirected to %s', loginUrl.pathname);

const loginPageResponse = await fetch(loginUrl, {
  redirect: 'manual',
  headers: createRequestHeaders(),
});
storeCookies(loginPageResponse);
ensureStatus(loginPageResponse, 200, 'Login page');

const loginBody = new URLSearchParams({
  username,
  password,
  return_to: returnTo,
});

const loginPostUrl = new URL('/oauth/login', origin);
const loginResponse = await fetch(loginPostUrl, {
  method: 'POST',
  redirect: 'manual',
  headers: createRequestHeaders({
    'Content-Type': 'application/x-www-form-urlencoded',
  }),
  body: loginBody,
});
storeCookies(loginResponse);
ensureStatus(loginResponse, 302, 'Login submission');

const resumeAuthorizeLocation = loginResponse.headers.get('location');
if (!resumeAuthorizeLocation) {
  throw new Error('Login submission missing resume Location header');
}

console.log('[client] Developer login succeeded, resuming authorization');

const resumeAuthorizeUrl = new URL(resumeAuthorizeLocation, origin);
const resumeAuthorizeResponse = await fetch(resumeAuthorizeUrl, {
  redirect: 'manual',
  headers: createRequestHeaders(),
});
storeCookies(resumeAuthorizeResponse);
ensureStatus(resumeAuthorizeResponse, 302, 'Authorization completion');

const redirectLocation = resumeAuthorizeResponse.headers.get('location');
if (!redirectLocation) {
  throw new Error('Authorization completion missing redirect Location');
}

const callbackUrl = new URL(redirectLocation);
const authorizationCode = callbackUrl.searchParams.get('code');
const returnedState = callbackUrl.searchParams.get('state');

if (!authorizationCode) {
  throw new Error('No authorization code found in redirect URL');
}
if (returnedState !== state) {
  throw new Error('Returned state mismatch');
}

console.log('[client] Received authorization code: %s', authorizationCode);

const tokenUrl = new URL('/oauth/token', origin);
const tokenBody = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: clientId,
  code: authorizationCode,
  redirect_uri: redirectUri,
  code_verifier: verifier,
});

const tokenResponse = await fetch(tokenUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: tokenBody,
});

ensureStatus(tokenResponse, 200, 'Token exchange');
const tokenJson = await tokenResponse.json();

if (!tokenJson.access_token) {
  throw new Error('Token response did not include access_token');
}

console.log('[client] Access token issued: %s', tokenJson.access_token);

const [headerSegment, payloadSegment] = tokenJson.access_token.split('.', 2);
if (headerSegment && payloadSegment) {
  const header = JSON.parse(
    decodeBase64Url(headerSegment).toString('utf8')
  );
  const payload = JSON.parse(
    decodeBase64Url(payloadSegment).toString('utf8')
  );
  console.log('[client] Decoded JWT header:', header);
  console.log('[client] Decoded JWT payload:', payload);
}

console.log('[client] Flow complete');
