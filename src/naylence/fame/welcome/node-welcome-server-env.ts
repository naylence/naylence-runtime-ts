export const ENV_VAR_FAME_APP_HOST = 'FAME_APP_HOST';
export const ENV_VAR_FAME_APP_PORT = 'FAME_APP_PORT';
export const ENV_VAR_KEY_TYPES = 'FAME_JWKS_KEY_TYPES';

export interface NodeWelcomeServerAddress {
  host: string;
  port: number;
}

function toCamelAlias(snakeKey: string): string {
  return snakeKey
    .toLowerCase()
    .replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function readEnvValue(
  env: NodeJS.ProcessEnv,
  snakeKey: string
): string | undefined {
  const direct = env[snakeKey];
  if (direct !== undefined) {
    return direct;
  }

  const lowerKey = snakeKey.toLowerCase();
  if (env[lowerKey] !== undefined) {
    return env[lowerKey];
  }

  const camelKey = toCamelAlias(snakeKey);
  if (env[camelKey] !== undefined) {
    return env[camelKey];
  }

  const pascalKey =
    camelKey.length > 0
      ? camelKey[0].toUpperCase() + camelKey.slice(1)
      : camelKey;
  if (pascalKey && env[pascalKey] !== undefined) {
    return env[pascalKey];
  }

  return undefined;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

export function getAllowedKeyTypesFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string[] | null {
  const envKeyTypes = readEnvValue(env, ENV_VAR_KEY_TYPES);
  if (typeof envKeyTypes !== 'string') {
    return null;
  }

  const results = envKeyTypes
    .split(/[\,\s]+/)
    .map((kty) => kty.trim())
    .filter((kty) => kty.length > 0);

  return results.length > 0 ? results : null;
}

export function resolveServerAddress(
  env: NodeJS.ProcessEnv = process.env
): NodeWelcomeServerAddress {
  const host = readEnvValue(env, ENV_VAR_FAME_APP_HOST) ?? '0.0.0.0';
  const port = parsePort(readEnvValue(env, ENV_VAR_FAME_APP_PORT), 8090);
  return { host, port };
}
