/**
 * OAuth2 client credentials and authorization code (PKCE) grant router for Fastify
 *
 * Provides /oauth/token and /oauth/authorize endpoints for local development and testing.
 * Implements OAuth2 client credentials grant with JWT token issuance and
 * OAuth2 authorization code grant with PKCE verification.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';
import { JWTTokenIssuer } from '../security/auth/jwt-token-issuer.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.http.oauth2_token_router');

type HttpMethod = 'GET' | 'POST';

interface CookieOptions {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
}

interface Request {
  body: any;
  headers: Record<string, string | undefined>;
  method: string;
  originalUrl: string;
  query: Record<string, any>;
}

interface Response {
  status(code: number): Response;
  set(field: string, value: string): Response;
  type(contentType: string): Response;
  json(payload: unknown): void;
  send(payload: unknown): void;
  redirect(url: string): void;
  redirect(statusCode: number, url: string): void;
  cookie(name: string, value: string, options: CookieOptions): void;
}

type RouteHandler = (req: Request, res: Response) => Promise<void> | void;

interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
}

class RouterCompat {
  private readonly routes: RouteDefinition[] = [];

  get(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'GET', path, handler });
  }

  post(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'POST', path, handler });
  }

  toPlugin(): FastifyPluginAsync {
    return async (fastify) => {
      await fastify.register(formbody);

      for (const route of this.routes) {
        fastify.route({
          method: route.method,
          url: route.path,
          handler: async (request, reply) => {
            const compatRequest = toCompatRequest(request);
            const compatResponse = new FastifyResponseAdapter(reply);
            await route.handler(compatRequest, compatResponse);
          },
        });
      }
    };
  }
}

class FastifyResponseAdapter implements Response {
  constructor(private readonly reply: FastifyReply) {}

  status(code: number): Response {
    this.reply.status(code);
    return this;
  }

  set(field: string, value: string): Response {
    if (field.toLowerCase() === 'set-cookie') {
      this.appendHeader(field, value);
    } else {
      this.reply.header(field, value);
    }
    return this;
  }

  type(contentType: string): Response {
    const normalized =
      contentType === 'html'
        ? 'text/html'
        : contentType === 'json'
          ? 'application/json'
          : contentType;
    this.reply.type(normalized);
    return this;
  }

  json(payload: unknown): void {
    this.reply.send(payload);
  }

  send(payload: unknown): void {
    this.reply.send(payload);
  }

  redirect(statusOrUrl: number | string, maybeUrl?: string): void {
    if (typeof statusOrUrl === 'number') {
      if (maybeUrl === undefined) {
        throw new Error(
          'redirect url is required when status code is provided'
        );
      }
      this.reply.status(statusOrUrl);
      this.reply.header('Location', maybeUrl);
      this.reply.send();
    } else {
      this.reply.redirect(statusOrUrl);
    }
  }

  cookie(name: string, value: string, options: CookieOptions): void {
    const serialized = serializeCookie(name, value, options);
    this.appendHeader('Set-Cookie', serialized);
  }

  private appendHeader(name: string, value: string): void {
    const existing = this.reply.getHeader(name);
    if (Array.isArray(existing)) {
      this.reply.header(name, [...existing, value]);
    } else if (typeof existing === 'string') {
      this.reply.header(name, [existing, value]);
    } else if (existing === undefined) {
      this.reply.header(name, value);
    } else {
      this.reply.header(name, [String(existing), value]);
    }
  }
}

function toCompatRequest(request: FastifyRequest): Request {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.join(', ');
    } else if (value !== undefined && value !== null) {
      headers[key.toLowerCase()] = String(value);
    } else {
      headers[key.toLowerCase()] = undefined;
    }
  }

  return {
    body: request.body,
    headers,
    method: request.method,
    originalUrl: request.raw.url ?? request.url,
    query: (request.query as Record<string, any>) ?? {},
  };
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions
): string {
  const segments: string[] = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
  ];

  if (options.maxAge !== undefined) {
    const maxAgeMs = options.maxAge;
    const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
    segments.push(`Max-Age=${maxAgeSeconds}`);
    const expires = new Date(Date.now() + maxAgeMs).toUTCString();
    segments.push(`Expires=${expires}`);
  }

  segments.push(`Path=${options.path ?? '/'}`);

  if (options.httpOnly) {
    segments.push('HttpOnly');
  }

  if (options.secure) {
    segments.push('Secure');
  }

  if (options.sameSite) {
    const normalized = options.sameSite.toLowerCase();
    const formatted =
      normalized === 'strict'
        ? 'Strict'
        : normalized === 'none'
          ? 'None'
          : 'Lax';
    segments.push(`SameSite=${formatted}`);
  }

  return segments.join('; ');
}

const DEFAULT_PREFIX = '/oauth';

const ENV_VAR_CLIENT_ID = 'FAME_JWT_CLIENT_ID';
const ENV_VAR_CLIENT_SECRET = 'FAME_JWT_CLIENT_SECRET';
const ENV_VAR_ALLOWED_SCOPES = 'FAME_JWT_ALLOWED_SCOPES';
const ENV_VAR_JWT_ISSUER = 'FAME_JWT_ISSUER';
const ENV_VAR_JWT_ALGORITHM = 'FAME_JWT_ALGORITHM';
const ENV_VAR_JWT_AUDIENCE = 'FAME_JWT_AUDIENCE';
const ENV_VAR_ENABLE_PKCE = 'FAME_OAUTH_ENABLE_PKCE';
const ENV_VAR_ALLOW_PUBLIC_CLIENTS = 'FAME_OAUTH_ALLOW_PUBLIC_CLIENTS';
const ENV_VAR_AUTHORIZATION_CODE_TTL = 'FAME_OAUTH_CODE_TTL_SEC';
const ENV_VAR_ENABLE_DEV_LOGIN = 'FAME_OAUTH_ENABLE_DEV_LOGIN';
const ENV_VAR_DEV_LOGIN_USERNAME = 'FAME_OAUTH_DEV_USERNAME';
const ENV_VAR_DEV_LOGIN_PASSWORD = 'FAME_OAUTH_DEV_PASSWORD';
const ENV_VAR_SESSION_TTL = 'FAME_OAUTH_SESSION_TTL_SEC';
const ENV_VAR_SESSION_COOKIE_NAME = 'FAME_OAUTH_SESSION_COOKIE_NAME';
const ENV_VAR_SESSION_SECURE_COOKIE = 'FAME_OAUTH_SESSION_SECURE';
const ENV_VAR_LOGIN_TITLE = 'FAME_OAUTH_LOGIN_TITLE';

const DEFAULT_JWT_ALGORITHM = 'EdDSA';
const DEFAULT_AUTHORIZATION_CODE_TTL_SEC = 300;
const DEFAULT_SESSION_TTL_SEC = 3600;
const DEFAULT_SESSION_COOKIE_NAME = 'naylence_dev_session';
const DEFAULT_LOGIN_TITLE = 'Developer Login';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

type PkceMethod = 'S256' | 'PLAIN';

interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge: string;
  codeChallengeMethod: PkceMethod;
  expiresAt: number;
  requestedState?: string;
}

interface DevLoginSession {
  id: string;
  username: string;
  expiresAt: number;
}

interface RenderLoginPageOptions {
  title: string;
  prefix: string;
  returnTo: string;
  username?: string;
  errorMessage?: string;
}

export interface CreateOAuth2TokenRouterOptions {
  /**
   * Crypto provider for JWT signing
   * Required for token issuance
   */
  cryptoProvider: CryptoProvider;

  /**
   * Router prefix (default: /oauth)
   */
  prefix?: string;

  /**
   * JWT issuer claim
   * Environment variable FAME_JWT_ISSUER takes priority
   * Default: https://auth.fame.fabric
   */
  issuer?: string;

  /**
   * JWT audience claim
   * Environment variable FAME_JWT_AUDIENCE takes priority
   * Default: fame-fabric
   */
  audience?: string;

  /**
   * Token TTL in seconds (default: 3600)
   */
  tokenTtlSec?: number;

  /**
   * Allowed scopes
   * Environment variable FAME_JWT_ALLOWED_SCOPES takes priority
   * Default: ['node.connect']
   */
  allowedScopes?: string[];

  /**
   * JWT signing algorithm
   * Environment variable FAME_JWT_ALGORITHM takes priority
   * Default: EdDSA
   */
  algorithm?: string;

  /**
   * Enable PKCE authorization code grant (default: true)
   */
  enablePkce?: boolean;

  /**
   * Allow public clients (no client_secret) for PKCE exchange (default: true)
   */
  allowPublicClients?: boolean;

  /**
   * Authorization code TTL in seconds (default: 300)
   */
  authorizationCodeTtlSec?: number;

  /**
   * Enable developer login experience for authorization flows (default: false)
   */
  enableDevLogin?: boolean;

  /**
   * Developer login username (required if enableDevLogin is true and not set via env)
   */
  devLoginUsername?: string;

  /**
   * Developer login password (required if enableDevLogin is true and not set via env)
   */
  devLoginPassword?: string;

  /**
   * Developer login session TTL in seconds (default: 3600)
   */
  devLoginSessionTtlSec?: number;

  /**
   * Cookie name for developer login session (default: naylence_dev_session)
    
    if (devLoginEnabled) {
      cleanupLoginSessions(loginSessions, Date.now());
      const activeSession = getActiveSession(
        req,
        loginSessions,
        devLoginCookieName,
        devLoginSessionTtlMs
      );
      if (!activeSession) {
        const returnTo = sanitizeReturnTo(
          req.originalUrl,
          sessionCookiePath,
          authorizationRedirectPath
        );
        const loginLocation = `${prefix}/login?return_to=${encodeURIComponent(
          returnTo
        )}`;
        setNoCacheHeaders(res);
        res.redirect(302, loginLocation);
        return;
      }
    }
   */
  devLoginCookieName?: string;

  /**
   * Whether to mark the developer login cookie as secure (default: false)
   */
  devLoginSecureCookie?: boolean;

  /**
   * Custom title for the developer login page (default: Developer Login)
   */
  devLoginTitle?: string;
}

interface NormalizedOAuth2TokenRouterOptions {
  cryptoProvider?: CryptoProvider;
  prefix?: string;
  issuer?: string;
  audience?: string;
  tokenTtlSec?: number;
  allowedScopes?: string[];
  algorithm?: string;
  enablePkce?: boolean;
  allowPublicClients?: boolean;
  authorizationCodeTtlSec?: number;
  enableDevLogin?: boolean;
  devLoginUsername?: string;
  devLoginPassword?: string;
  devLoginSessionTtlSec?: number;
  devLoginCookieName?: string;
  devLoginSecureCookie?: boolean;
  devLoginTitle?: string;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
    }
  }
  return undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => coerceString(entry))
      .filter((entry): entry is string => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
  }

  const text = coerceString(value);
  if (text) {
    const entries = text
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.length > 0 ? entries : undefined;
  }

  return undefined;
}

function normalizeCreateOAuth2TokenRouterOptions(
  options: CreateOAuth2TokenRouterOptions
): NormalizedOAuth2TokenRouterOptions {
  const descriptor = options as CreateOAuth2TokenRouterOptions &
    Record<string, unknown>;

  const cryptoProvider =
    descriptor.cryptoProvider ??
    ((descriptor as any).crypto_provider as CryptoProvider | undefined);

  const prefix =
    coerceString(descriptor.prefix) ?? coerceString((descriptor as any).prefix);

  const issuer =
    coerceString(descriptor.issuer) ?? coerceString((descriptor as any).issuer);

  const audience =
    coerceString(descriptor.audience) ??
    coerceString((descriptor as any).audience);

  const allowedScopes =
    coerceStringArray(descriptor.allowedScopes) ??
    coerceStringArray((descriptor as any).allowed_scopes);

  const algorithm =
    coerceString(descriptor.algorithm) ??
    coerceString((descriptor as any).algorithm);

  const tokenTtlSec =
    coerceNumber(descriptor.tokenTtlSec) ??
    coerceNumber((descriptor as any).token_ttl_sec);

  const enablePkce =
    coerceBoolean(descriptor.enablePkce) ??
    coerceBoolean((descriptor as any).enable_pkce);

  const allowPublicClients =
    coerceBoolean(descriptor.allowPublicClients) ??
    coerceBoolean((descriptor as any).allow_public_clients);

  const authorizationCodeTtlSec =
    coerceNumber(descriptor.authorizationCodeTtlSec) ??
    coerceNumber((descriptor as any).authorization_code_ttl_sec);

  const enableDevLogin =
    coerceBoolean(descriptor.enableDevLogin) ??
    coerceBoolean((descriptor as any).enable_dev_login);

  const devLoginUsername =
    coerceString(descriptor.devLoginUsername) ??
    coerceString((descriptor as any).dev_login_username);

  const devLoginPassword =
    coerceString(descriptor.devLoginPassword) ??
    coerceString((descriptor as any).dev_login_password);

  const devLoginSessionTtlSec =
    coerceNumber(descriptor.devLoginSessionTtlSec) ??
    coerceNumber((descriptor as any).dev_login_session_ttl_sec);

  const devLoginCookieName =
    coerceString(descriptor.devLoginCookieName) ??
    coerceString((descriptor as any).dev_login_cookie_name);

  const devLoginSecureCookie =
    coerceBoolean(descriptor.devLoginSecureCookie) ??
    coerceBoolean((descriptor as any).dev_login_secure_cookie);

  const devLoginTitle =
    coerceString(descriptor.devLoginTitle) ??
    coerceString((descriptor as any).dev_login_title);

  return {
    cryptoProvider,
    prefix,
    issuer,
    audience,
    allowedScopes,
    algorithm,
    tokenTtlSec,
    enablePkce,
    allowPublicClients,
    authorizationCodeTtlSec,
    enableDevLogin,
    devLoginUsername,
    devLoginPassword,
    devLoginSessionTtlSec,
    devLoginCookieName,
    devLoginSecureCookie,
    devLoginTitle,
  };
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Parse Basic Auth header
 */
function parseBasicAuth(
  authHeader: string | undefined
): ClientCredentials | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  try {
    const base64Credentials = authHeader.substring(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString(
      'utf-8'
    );
    const [clientId, clientSecret] = credentials.split(':');

    if (!clientId || !clientSecret) {
      return null;
    }

    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

/**
 * Get configured client credentials from environment
 */
function getConfiguredClientCredentials(): ClientCredentials {
  const clientId = process.env[ENV_VAR_CLIENT_ID];
  const clientSecret = process.env[ENV_VAR_CLIENT_SECRET];

  if (!clientId || !clientSecret) {
    throw new Error(
      `Server configuration error: ${ENV_VAR_CLIENT_ID} and ${ENV_VAR_CLIENT_SECRET} must be set`
    );
  }

  return { clientId, clientSecret };
}

/**
 * Verify client credentials
 */
function verifyClientCredentials(
  requestCreds: ClientCredentials,
  configuredCreds: ClientCredentials
): boolean {
  return (
    requestCreds.clientId === configuredCreds.clientId &&
    requestCreds.clientSecret === configuredCreds.clientSecret
  );
}

/**
 * Parse and validate allowed scopes from environment or config
 */
function getAllowedScopes(configScopes?: string[]): string[] {
  const envScopes = process.env[ENV_VAR_ALLOWED_SCOPES];
  if (envScopes) {
    return envScopes
      .replace(/,/g, ' ')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return configScopes ?? ['node.connect'];
}

/**
 * Validate requested scope and return granted scopes
 */
function validateScope(
  requestedScope: string | undefined,
  allowedScopes: string[]
): string[] {
  if (!requestedScope) {
    return allowedScopes;
  }

  const requestedScopes = requestedScope.split(/\s+/);
  const grantedScopes = requestedScopes.filter((scope) =>
    allowedScopes.includes(scope)
  );

  return grantedScopes.length > 0 ? grantedScopes : allowedScopes;
}

function base64UrlEncode(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function computeS256Challenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier, 'utf8').digest();
  return base64UrlEncode(digest);
}

function safeTimingEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function isValidCodeVerifier(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  if (value.length < 43 || value.length > 128) {
    return false;
  }
  return /^[A-Za-z0-9\-._~]+$/u.test(value);
}

function isValidCodeChallenge(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  if (value.length < 43 || value.length > 128) {
    return false;
  }
  return /^[A-Za-z0-9\-._~]+$/u.test(value);
}

function generateAuthorizationCode(): string {
  return base64UrlEncode(randomBytes(32));
}

function generateSessionId(): string {
  return base64UrlEncode(randomBytes(32));
}

function cleanupAuthorizationCodes(
  store: Map<string, AuthorizationCodeRecord>,
  nowMs: number
): void {
  for (const [code, record] of store.entries()) {
    if (record.expiresAt <= nowMs) {
      store.delete(code);
    }
  }
}

function toSingleQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 ? coerceString(value[0]) : undefined;
  }
  return coerceString(value);
}

function ensurePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .reduce<Record<string, string>>((acc, entry) => {
      const [rawName, ...rawValueParts] = entry.split('=');
      const name = rawName?.trim();
      if (!name) {
        return acc;
      }
      const rawValue = rawValueParts.join('=').trim();
      if (rawValue.length === 0) {
        return acc;
      }
      try {
        acc[name] = decodeURIComponent(rawValue);
      } catch {
        acc[name] = rawValue;
      }
      return acc;
    }, {});
}

function sanitizeReturnTo(
  value: string | undefined,
  allowedPrefix: string,
  fallback: string
): string {
  if (!value) {
    return fallback;
  }

  try {
    const candidate = new URL(value, 'http://localhost');
    if (candidate.origin !== 'http://localhost') {
      return fallback;
    }
    if (!candidate.pathname.startsWith(allowedPrefix)) {
      return fallback;
    }
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return fallback;
  }
}

function escapeHtml(text: string | undefined): string {
  if (!text) {
    return '';
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLoginPage(options: RenderLoginPageOptions): string {
  const { title, prefix, returnTo, username, errorMessage } = options;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
      .card { width: min(360px, 100%); background: rgba(15, 23, 42, 0.92); border-radius: 16px; padding: 32px; box-shadow: 0 20px 45px rgba(15, 23, 42, 0.25); color: #e2e8f0; backdrop-filter: blur(20px); }
      h1 { margin: 0 0 24px; font-size: 24px; font-weight: 600; text-align: center; }
      label { display: block; font-size: 14px; margin-bottom: 8px; color: #cbd5f5; }
      input[type="text"], input[type="password"] { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.4); background: rgba(15, 23, 42, 0.6); color: inherit; font-size: 15px; transition: border-color 0.2s, box-shadow 0.2s; }
      input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.25); }
      .field { margin-bottom: 18px; }
      button { width: 100%; padding: 12px 14px; border-radius: 10px; border: none; background: linear-gradient(135deg, #38bdf8, #818cf8); color: #0f172a; font-weight: 600; font-size: 15px; cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; }
      button:hover { transform: translateY(-1px); box-shadow: 0 10px 25px rgba(129, 140, 248, 0.35); }
      .error { margin-bottom: 18px; padding: 12px 14px; border-radius: 10px; background: rgba(239, 68, 68, 0.18); color: #fecaca; font-size: 13px; }
      .support { margin-top: 16px; font-size: 12px; text-align: center; color: rgba(148, 163, 184, 0.75); }
      a { color: #38bdf8; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .brand { text-align: center; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(148, 163, 184, 0.9); margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand">NAYLENCE</div>
      <h1>${escapeHtml(title)}</h1>
      ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
      <form method="post" action="${escapeHtml(`${prefix}/login`)}">
        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            value="${escapeHtml(username ?? '')}"
            required
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
        <button type="submit">Sign in</button>
      </form>
      <p class="support">Cookies are used to keep your session active in this local environment.</p>
    </main>
  </body>
</html>`;
}

function normalizeCookiePath(prefix: string): string {
  if (!prefix || prefix === '/') {
    return '/';
  }
  return prefix.endsWith('/') && prefix.length > 1
    ? prefix.slice(0, -1)
    : prefix;
}

function cleanupLoginSessions(
  store: Map<string, DevLoginSession>,
  nowMs: number
): void {
  for (const [key, record] of store.entries()) {
    if (record.expiresAt <= nowMs) {
      store.delete(key);
    }
  }
}

function getActiveSession(
  req: Request,
  store: Map<string, DevLoginSession>,
  cookieName: string,
  sessionTtlMs: number
): DevLoginSession | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[cookieName];
  if (!sessionId) {
    return undefined;
  }

  const record = store.get(sessionId);
  if (!record) {
    return undefined;
  }

  const now = Date.now();
  if (record.expiresAt <= now) {
    store.delete(sessionId);
    return undefined;
  }

  record.expiresAt = now + sessionTtlMs;
  store.set(sessionId, record);
  return record;
}

function setNoCacheHeaders(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
}

function respondInvalidClient(res: Response): void {
  res.status(401).set('WWW-Authenticate', 'Basic').json({
    error: 'invalid_client',
    error_description: 'Invalid client credentials',
  });
}

/**
 * Create a Fastify plugin that implements OAuth2 token and authorization endpoints
 * with support for client credentials and authorization code (PKCE) grants.
 *
 * @param options - Router configuration options
 * @returns Fastify plugin with OAuth2 token and authorization endpoints
 *
 * Environment Variables:
 *   FAME_JWT_CLIENT_ID: OAuth2 client identifier
 *   FAME_JWT_CLIENT_SECRET: OAuth2 client secret
 *   FAME_JWT_ISSUER: JWT issuer claim (optional)
 *   FAME_JWT_AUDIENCE: JWT audience claim (optional)
 *   FAME_JWT_ALGORITHM: JWT signing algorithm (optional, default: EdDSA)
 *   FAME_JWT_ALLOWED_SCOPES: Allowed scopes (optional, default: node.connect)
 *   FAME_OAUTH_ENABLE_PKCE: Enable PKCE authorization endpoints (optional, default: true)
 *   FAME_OAUTH_ALLOW_PUBLIC_CLIENTS: Allow PKCE exchanges without client_secret (optional, default: true)
 *   FAME_OAUTH_CODE_TTL_SEC: Authorization code TTL in seconds (optional, default: 300)
 */
export function createOAuth2TokenRouter(
  options: CreateOAuth2TokenRouterOptions
): FastifyPluginAsync {
  const router = new RouterCompat();

  const {
    cryptoProvider,
    prefix = DEFAULT_PREFIX,
    issuer,
    audience,
    tokenTtlSec,
    allowedScopes: configAllowedScopes,
    algorithm: configAlgorithm,
    enablePkce: configEnablePkce,
    allowPublicClients: configAllowPublicClients,
    authorizationCodeTtlSec: configAuthorizationCodeTtlSec,
    enableDevLogin: configEnableDevLogin,
    devLoginUsername: configDevLoginUsername,
    devLoginPassword: configDevLoginPassword,
    devLoginSessionTtlSec: configDevLoginSessionTtlSec,
    devLoginCookieName: configDevLoginCookieName,
    devLoginSecureCookie: configDevLoginSecureCookie,
    devLoginTitle: configDevLoginTitle,
  } = normalizeCreateOAuth2TokenRouterOptions(options);

  if (!cryptoProvider) {
    throw new Error('cryptoProvider is required to create OAuth2 token router');
  }

  const provider = cryptoProvider;

  const defaultIssuer =
    process.env[ENV_VAR_JWT_ISSUER] ?? issuer ?? 'https://auth.fame.fabric';
  const defaultAudience =
    process.env[ENV_VAR_JWT_AUDIENCE] ?? audience ?? 'fame-fabric';
  const algorithm =
    process.env[ENV_VAR_JWT_ALGORITHM] ??
    configAlgorithm ??
    DEFAULT_JWT_ALGORITHM;
  const allowedScopes = getAllowedScopes(configAllowedScopes);
  const resolvedTokenTtlSec = tokenTtlSec ?? 3600;
  const enablePkce =
    coerceBoolean(process.env[ENV_VAR_ENABLE_PKCE]) ?? configEnablePkce ?? true;
  const allowPublicClients =
    coerceBoolean(process.env[ENV_VAR_ALLOW_PUBLIC_CLIENTS]) ??
    configAllowPublicClients ??
    true;
  const authorizationCodeTtlSec =
    ensurePositiveInteger(
      coerceNumber(process.env[ENV_VAR_AUTHORIZATION_CODE_TTL]) ??
        configAuthorizationCodeTtlSec
    ) ?? DEFAULT_AUTHORIZATION_CODE_TTL_SEC;

  const devLoginExplicitlyEnabled =
    coerceBoolean(process.env[ENV_VAR_ENABLE_DEV_LOGIN]) ??
    configEnableDevLogin;
  const devLoginUsername =
    coerceString(process.env[ENV_VAR_DEV_LOGIN_USERNAME]) ??
    configDevLoginUsername;
  const devLoginPassword =
    coerceString(process.env[ENV_VAR_DEV_LOGIN_PASSWORD]) ??
    configDevLoginPassword;
  const devLoginSessionTtlSec =
    ensurePositiveInteger(
      coerceNumber(process.env[ENV_VAR_SESSION_TTL]) ??
        configDevLoginSessionTtlSec
    ) ?? DEFAULT_SESSION_TTL_SEC;
  const devLoginCookieName =
    coerceString(process.env[ENV_VAR_SESSION_COOKIE_NAME]) ??
    configDevLoginCookieName ??
    DEFAULT_SESSION_COOKIE_NAME;
  const devLoginSecureCookie =
    coerceBoolean(process.env[ENV_VAR_SESSION_SECURE_COOKIE]) ??
    configDevLoginSecureCookie ??
    false;
  const devLoginTitle =
    coerceString(process.env[ENV_VAR_LOGIN_TITLE]) ??
    configDevLoginTitle ??
    DEFAULT_LOGIN_TITLE;

  const devLoginCredentialsConfigured =
    !!devLoginUsername && !!devLoginPassword;
  const devLoginEnabled =
    (devLoginExplicitlyEnabled ?? false) || devLoginCredentialsConfigured;

  if (devLoginEnabled && !devLoginCredentialsConfigured) {
    throw new Error(
      'Developer login is enabled but credentials are not configured'
    );
  }

  const sessionCookiePath = normalizeCookiePath(prefix);
  const authorizationRedirectPath = prefix.endsWith('/')
    ? `${prefix}authorize`
    : `${prefix}/authorize`;
  const devLoginSessionTtlMs = devLoginSessionTtlSec * 1000;

  logger.debug('oauth2_router_created', {
    prefix,
    issuer: defaultIssuer,
    audience: defaultAudience,
    algorithm,
    allowedScopes,
    tokenTtlSec: resolvedTokenTtlSec,
    enablePkce,
    allowPublicClients,
    authorizationCodeTtlSec,
    devLoginEnabled,
    devLoginSessionTtlSec,
    devLoginCookieName,
    devLoginSecureCookie,
  });

  const authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  const loginSessions = new Map<string, DevLoginSession>();

  if (devLoginEnabled) {
    logger.info('oauth2_dev_login_enabled', {
      loginTitle: devLoginTitle,
      cookieName: devLoginCookieName,
      sessionTtlSec: devLoginSessionTtlSec,
      secureCookie: devLoginSecureCookie,
    });
  }

  router.get(`${prefix}/authorize`, (req: Request, res: Response) => {
    if (!enablePkce) {
      res.status(404).json({
        error: 'endpoint_disabled',
        error_description: 'PKCE authorization endpoint is disabled',
      });
      return;
    }

    cleanupAuthorizationCodes(authorizationCodes, Date.now());

    if (devLoginEnabled) {
      cleanupLoginSessions(loginSessions, Date.now());
      const activeSession = getActiveSession(
        req,
        loginSessions,
        devLoginCookieName,
        devLoginSessionTtlMs
      );
      if (!activeSession) {
        const returnTo = sanitizeReturnTo(
          req.originalUrl,
          sessionCookiePath,
          authorizationRedirectPath
        );
        const loginLocation = `${prefix}/login?return_to=${encodeURIComponent(
          returnTo
        )}`;
        setNoCacheHeaders(res);
        res.redirect(302, loginLocation);
        return;
      }
    }

    let configuredCreds: ClientCredentials;
    try {
      configuredCreds = getConfiguredClientCredentials();
    } catch (error) {
      logger.error('oauth2_config_error', {
        error: (error as Error).message,
      });
      res.status(500).json({
        error: 'server_error',
        error_description: 'Server configuration error',
      });
      return;
    }

    const responseType = toSingleQueryValue(req.query.response_type);
    if (responseType !== 'code') {
      res.status(400).json({
        error: 'unsupported_response_type',
        error_description: 'Only authorization code response type is supported',
      });
      return;
    }

    const clientId = toSingleQueryValue(req.query.client_id);
    if (!clientId) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id is required',
      });
      return;
    }

    if (clientId !== configuredCreds.clientId) {
      logger.warning('oauth2_authorize_invalid_client', { clientId });
      respondInvalidClient(res);
      return;
    }

    const redirectUriText = toSingleQueryValue(req.query.redirect_uri);
    if (!redirectUriText) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      });
      return;
    }

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(redirectUriText);
    } catch {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri must be a valid absolute URL',
      });
      return;
    }

    const requestedScope = toSingleQueryValue(req.query.scope);
    const grantedScopes = validateScope(requestedScope, allowedScopes);

    const codeChallenge = toSingleQueryValue(req.query.code_challenge);
    if (!isValidCodeChallenge(codeChallenge)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'code_challenge is invalid or missing',
      });
      return;
    }

    const codeChallengeMethodCandidate = (
      toSingleQueryValue(req.query.code_challenge_method) ?? 'S256'
    ).toUpperCase();
    const codeChallengeMethod: PkceMethod =
      codeChallengeMethodCandidate === 'PLAIN' ? 'PLAIN' : 'S256';

    const state = toSingleQueryValue(req.query.state);

    const authorizationCode = generateAuthorizationCode();
    const expiresAt = Date.now() + authorizationCodeTtlSec * 1000;

    authorizationCodes.set(authorizationCode, {
      code: authorizationCode,
      clientId,
      redirectUri: redirectUrl.toString(),
      scope: grantedScopes,
      codeChallenge,
      codeChallengeMethod,
      expiresAt,
      requestedState: state,
    });

    logger.debug('oauth2_authorization_code_issued', {
      clientId,
      scope: grantedScopes,
      method: codeChallengeMethod,
      expiresAt,
    });

    const redirectLocation = new URL(redirectUrl.toString());
    redirectLocation.searchParams.set('code', authorizationCode);
    if (state) {
      redirectLocation.searchParams.set('state', state);
    }
    if (grantedScopes.length > 0) {
      redirectLocation.searchParams.set('scope', grantedScopes.join(' '));
    }

    setNoCacheHeaders(res);
    res.redirect(302, redirectLocation.toString());
  });

  router.get(`${prefix}/login`, (req: Request, res: Response) => {
    if (!devLoginEnabled) {
      res.status(404).json({
        error: 'endpoint_disabled',
        error_description: 'Developer login is disabled',
      });
      return;
    }

    cleanupLoginSessions(loginSessions, Date.now());
    const returnTo = sanitizeReturnTo(
      toSingleQueryValue(req.query.return_to),
      sessionCookiePath,
      authorizationRedirectPath
    );
    const session = getActiveSession(
      req,
      loginSessions,
      devLoginCookieName,
      devLoginSessionTtlMs
    );

    if (session) {
      setNoCacheHeaders(res);
      res.redirect(302, returnTo);
      return;
    }

    const html = renderLoginPage({
      title: devLoginTitle,
      prefix,
      returnTo,
      username: undefined,
      errorMessage: undefined,
    });
    setNoCacheHeaders(res);
    res.status(200).type('html').send(html);
  });

  router.post(`${prefix}/login`, (req: Request, res: Response) => {
    if (!devLoginEnabled) {
      res.status(404).json({
        error: 'endpoint_disabled',
        error_description: 'Developer login is disabled',
      });
      return;
    }

    cleanupLoginSessions(loginSessions, Date.now());

    const username = coerceString(req.body?.username);
    const password = coerceString(req.body?.password);
    const returnTo = sanitizeReturnTo(
      coerceString(req.body?.return_to),
      sessionCookiePath,
      authorizationRedirectPath
    );

    if (!username || !password) {
      const html = renderLoginPage({
        title: devLoginTitle,
        prefix,
        returnTo,
        username: username ?? undefined,
        errorMessage: 'Username and password are required.',
      });
      setNoCacheHeaders(res);
      res.status(400).type('html').send(html);
      return;
    }

    if (username !== devLoginUsername || password !== devLoginPassword) {
      logger.warning('oauth2_dev_login_failed', { username });
      const html = renderLoginPage({
        title: devLoginTitle,
        prefix,
        returnTo,
        username,
        errorMessage: 'Invalid username or password.',
      });
      setNoCacheHeaders(res);
      res.status(401).type('html').send(html);
      return;
    }

    const sessionId = generateSessionId();
    const expiresAt = Date.now() + devLoginSessionTtlMs;
    loginSessions.set(sessionId, {
      id: sessionId,
      username,
      expiresAt,
    });

    const cookieOptions: CookieOptions = {
      httpOnly: true,
      sameSite: 'lax',
      path: sessionCookiePath,
      maxAge: devLoginSessionTtlMs,
    };
    if (devLoginSecureCookie) {
      cookieOptions.secure = true;
    }

    res.cookie(devLoginCookieName, sessionId, cookieOptions);
    logger.info('oauth2_dev_login_success', { username });
    setNoCacheHeaders(res);
    res.redirect(302, returnTo);
  });

  const logoutHandler = (req: Request, res: Response) => {
    if (!devLoginEnabled) {
      res.status(404).json({
        error: 'endpoint_disabled',
        error_description: 'Developer login is disabled',
      });
      return;
    }

    cleanupLoginSessions(loginSessions, Date.now());
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[devLoginCookieName];
    if (sessionId) {
      loginSessions.delete(sessionId);
    }

    const cookieOptions: CookieOptions = {
      httpOnly: true,
      sameSite: 'lax',
      path: sessionCookiePath,
      maxAge: 0,
    };
    if (devLoginSecureCookie) {
      cookieOptions.secure = true;
    }

    res.cookie(devLoginCookieName, '', cookieOptions);
    setNoCacheHeaders(res);
    res.redirect(302, `${prefix}/login`);
  };

  router.post(`${prefix}/logout`, logoutHandler);
  router.get(`${prefix}/logout`, logoutHandler);

  router.post(`${prefix}/token`, async (req: Request, res: Response) => {
    try {
      cleanupAuthorizationCodes(authorizationCodes, Date.now());

      const {
        grant_type,
        client_id,
        client_secret,
        scope,
        audience: reqAudience,
        code,
        redirect_uri,
        code_verifier,
      } = req.body ?? {};

      if (
        grant_type !== 'client_credentials' &&
        grant_type !== 'authorization_code'
      ) {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description:
            'Only client_credentials and authorization_code grant types are supported',
        });
        return;
      }

      let configuredCreds: ClientCredentials;
      try {
        configuredCreds = getConfiguredClientCredentials();
      } catch (error) {
        logger.error('oauth2_config_error', {
          error: (error as Error).message,
        });
        res.status(500).json({
          error: 'server_error',
          error_description: 'Server configuration error',
        });
        return;
      }

      const authHeader = req.headers.authorization;
      const basicAuthCreds = parseBasicAuth(authHeader);
      const bodyClientId = coerceString(client_id);
      const bodyClientSecret = coerceString(client_secret);

      const resolvedClientId = basicAuthCreds?.clientId ?? bodyClientId;

      if (!resolvedClientId) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'client_id is required',
        });
        return;
      }

      if (resolvedClientId !== configuredCreds.clientId) {
        logger.warning('oauth2_invalid_client_id', {
          clientId: resolvedClientId,
        });
        respondInvalidClient(res);
        return;
      }

      const providedSecret =
        basicAuthCreds?.clientSecret ?? bodyClientSecret ?? undefined;

      let clientAuthenticated = false;
      if (providedSecret !== undefined) {
        clientAuthenticated = verifyClientCredentials(
          { clientId: resolvedClientId, clientSecret: providedSecret },
          configuredCreds
        );
        if (!clientAuthenticated) {
          logger.warning('oauth2_invalid_credentials', {
            clientId: resolvedClientId,
          });
          respondInvalidClient(res);
          return;
        }
      }

      if (grant_type === 'client_credentials') {
        if (!clientAuthenticated) {
          respondInvalidClient(res);
          return;
        }

        if (!provider.signingPrivatePem || !provider.signatureKeyId) {
          logger.error('oauth2_missing_keys', {
            hasPrivateKey: !!provider.signingPrivatePem,
            hasKeyId: !!provider.signatureKeyId,
          });
          res.status(500).json({
            error: 'server_error',
            error_description: 'Server cryptographic configuration error',
          });
          return;
        }

        const grantedScopes = validateScope(scope, allowedScopes);
        const response = await issueTokenResponse({
          clientId: resolvedClientId,
          scopes: grantedScopes,
          audience: coerceString(reqAudience),
        });

        setNoCacheHeaders(res);
        res.json(response);
        return;
      }

      if (!enablePkce) {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'PKCE support is disabled',
        });
        return;
      }

      if (!clientAuthenticated && !allowPublicClients) {
        respondInvalidClient(res);
        return;
      }

      const authorizationCode = coerceString(code);
      const redirectUriText = coerceString(redirect_uri);
      const verifier = coerceString(code_verifier);

      if (
        !authorizationCode ||
        !redirectUriText ||
        !isValidCodeVerifier(verifier)
      ) {
        res.status(400).json({
          error: 'invalid_request',
          error_description:
            'code, redirect_uri, and a valid code_verifier are required for PKCE',
        });
        return;
      }

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(redirectUriText);
      } catch {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri must be a valid absolute URL',
        });
        return;
      }

      const record = authorizationCodes.get(authorizationCode);
      if (!record) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Authorization code is invalid or expired',
        });
        return;
      }

      if (record.expiresAt <= Date.now()) {
        authorizationCodes.delete(authorizationCode);
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Authorization code has expired',
        });
        return;
      }

      if (record.clientId !== resolvedClientId) {
        authorizationCodes.delete(authorizationCode);
        respondInvalidClient(res);
        return;
      }

      if (record.redirectUri !== redirectUrl.toString()) {
        authorizationCodes.delete(authorizationCode);
        res.status(400).json({
          error: 'invalid_grant',
          error_description:
            'redirect_uri does not match authorization request',
        });
        return;
      }

      let pkceValid = false;
      if (record.codeChallengeMethod === 'S256') {
        const expected = record.codeChallenge;
        const actual = computeS256Challenge(verifier);
        pkceValid = safeTimingEqual(expected, actual);
      } else {
        pkceValid = safeTimingEqual(record.codeChallenge, verifier);
      }

      if (!pkceValid) {
        authorizationCodes.delete(authorizationCode);
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'code_verifier does not match code_challenge',
        });
        return;
      }

      authorizationCodes.delete(authorizationCode);

      if (!provider.signingPrivatePem || !provider.signatureKeyId) {
        logger.error('oauth2_missing_keys', {
          hasPrivateKey: !!provider.signingPrivatePem,
          hasKeyId: !!provider.signatureKeyId,
        });
        res.status(500).json({
          error: 'server_error',
          error_description: 'Server cryptographic configuration error',
        });
        return;
      }

      const response = await issueTokenResponse({
        clientId: resolvedClientId,
        scopes: record.scope,
        audience: coerceString(reqAudience),
      });

      setNoCacheHeaders(res);
      res.json(response);
    } catch (error) {
      logger.error('oauth2_token_error', { error: (error as Error).message });
      throw error;
    }
  });

  async function issueTokenResponse(params: {
    clientId: string;
    scopes: string[];
    audience?: string;
  }): Promise<TokenResponse> {
    const tokenIssuer = new JWTTokenIssuer({
      signingKeyPem: provider.signingPrivatePem ?? undefined,
      kid: provider.signatureKeyId ?? undefined,
      issuer: defaultIssuer,
      algorithm,
      ttlSec: resolvedTokenTtlSec,
      audience: params.audience ?? defaultAudience,
    });

    const claims: Record<string, unknown> = {
      sub: params.clientId,
      client_id: params.clientId,
      scope: params.scopes.join(' '),
    };

    const accessToken = await tokenIssuer.issue(claims);

    logger.debug('oauth2_token_issued', {
      clientId: params.clientId,
      scopes: params.scopes,
      algorithm,
    });

    const response: TokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: resolvedTokenTtlSec,
    };

    if (params.scopes.length > 0) {
      response.scope = params.scopes.join(' ');
    }

    return response;
  }

  return router.toPlugin();
}
