import { z } from 'zod';

export interface FameServerRouteConfig {
  token: string;
  jwks: string;
  openIdConfiguration: string;
  health: string;
  metrics: string;
}

export interface FameServerClientConfig {
  id: string;
  secret: string;
  scopes: string[];
  audience?: string;
  metadata: Record<string, unknown>;
}

export interface FameServerConfig {
  host: string;
  port: number;
  basePath: string;
  trustProxy: boolean | string | readonly string[];
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  pluginTimeoutMs: number;
  bodyLimitBytes: number;
  maxParamLength: number;
  enableIntrospection: boolean;
  defaultAudience?: string;
  routes: FameServerRouteConfig;
  clients: FameServerClientConfig[];
}

export interface FameServerClientConfigInput {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  audience?: string;
  metadata?: Record<string, unknown>;
}

export interface FameServerConfigInput {
  host?: string;
  port?: number | string;
  basePath?: string;
  trustProxy?: boolean | string | string[];
  requestTimeoutMs?: number | string;
  keepAliveTimeoutMs?: number | string;
  headersTimeoutMs?: number | string;
  pluginTimeoutMs?: number | string;
  bodyLimitBytes?: number | string;
  maxParamLength?: number | string;
  enableIntrospection?: boolean;
  defaultAudience?: string;
  routes?: Partial<FameServerRouteConfig>;
  clients?: FameServerClientConfigInput[];
}

const FameServerClientSchema = z
  .object({
    clientId: z.string().trim().min(1, 'OAuth client must include clientId'),
    clientSecret: z.string().min(1, 'OAuth client must include clientSecret'),
    scopes: z.array(z.string()).optional(),
    audience: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((value) => ({
    clientId: value.clientId.trim(),
    clientSecret: value.clientSecret,
    scopes: (value.scopes ?? []).map((scope) => scope.trim()).filter((scope) => scope.length > 0),
    audience: value.audience?.trim() ?? undefined,
    metadata: value.metadata ?? {},
  }));

const FameServerConfigSchema = z
  .object({
    host: z.string().trim().min(1).default('0.0.0.0'),
    port: z.coerce.number().int().min(0).max(65535).default(8080),
    basePath: z.string().default(''),
    trustProxy: z.union([z.boolean(), z.string(), z.array(z.string())]).default(false),
    requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
    keepAliveTimeoutMs: z.coerce.number().int().positive().default(5_000),
    headersTimeoutMs: z.coerce.number().int().positive().default(60_000),
    pluginTimeoutMs: z.coerce.number().int().positive().default(10_000),
    bodyLimitBytes: z.coerce.number().int().positive().default(1_048_576),
    maxParamLength: z.coerce.number().int().positive().default(100),
    enableIntrospection: z.boolean().default(false),
    defaultAudience: z.string().optional(),
    routes: z.unknown().optional(),
    clients: z.array(FameServerClientSchema).default([]),
  })
  .passthrough();

export function normalizeFameServerConfig(input?: FameServerConfigInput | null): FameServerConfig {
  const parsed = FameServerConfigSchema.parse(input ?? {});
  const basePath = normalizeBasePath(parsed.basePath ?? '');
  const routes = normalizeRouteConfig(parsed.routes);

  const clients: FameServerClientConfig[] = [];
  const seenIds = new Set<string>();

  for (const client of parsed.clients) {
    if (seenIds.has(client.clientId)) {
      throw new Error(`Duplicate OAuth client id detected: ${client.clientId}`);
    }
    seenIds.add(client.clientId);
    const normalizedClient: FameServerClientConfig = {
      id: client.clientId,
      secret: client.clientSecret,
      scopes: client.scopes,
      metadata: { ...client.metadata },
    };
    if (client.audience !== undefined) {
      normalizedClient.audience = client.audience;
    }
    clients.push(normalizedClient);
  }

  const config: FameServerConfig = {
    host: parsed.host,
    port: parsed.port,
    basePath,
    trustProxy: parsed.trustProxy,
    requestTimeoutMs: parsed.requestTimeoutMs,
    keepAliveTimeoutMs: parsed.keepAliveTimeoutMs,
    headersTimeoutMs: parsed.headersTimeoutMs,
    pluginTimeoutMs: parsed.pluginTimeoutMs,
    bodyLimitBytes: parsed.bodyLimitBytes,
    maxParamLength: parsed.maxParamLength,
    enableIntrospection: parsed.enableIntrospection,
    routes,
    clients,
  };

  if (parsed.defaultAudience !== undefined) {
    const trimmedAudience = parsed.defaultAudience.trim();
    if (trimmedAudience.length > 0) {
      config.defaultAudience = trimmedAudience;
    }
  }

  return config;
}

export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (trimmed === '' || trimmed === '/') {
    return '';
  }

  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/+$/, '');
}

function normalizeRoutePath(path: string): string {
  if (!path || path === '/') {
    return path === '/' ? '/' : '';
  }

  const trimmed = path.trim();
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (prefixed === '/') {
    return prefixed;
  }
  return prefixed.replace(/\/+$/, '');
}

function normalizeRouteConfig(value: unknown): FameServerRouteConfig {
  const candidate = (value ?? {}) as Partial<FameServerRouteConfig> & Record<string, unknown>;
  return {
    token: normalizeRoutePath(typeof candidate.token === 'string' ? candidate.token : '/oauth/token'),
    jwks: normalizeRoutePath(
      typeof candidate.jwks === 'string' ? candidate.jwks : '/.well-known/jwks.json'
    ),
    openIdConfiguration: normalizeRoutePath(
      typeof candidate.openIdConfiguration === 'string'
        ? candidate.openIdConfiguration
        : '/.well-known/openid-configuration'
    ),
    health: normalizeRoutePath(typeof candidate.health === 'string' ? candidate.health : '/healthz'),
    metrics: normalizeRoutePath(typeof candidate.metrics === 'string' ? candidate.metrics : '/metrics'),
  };
}
