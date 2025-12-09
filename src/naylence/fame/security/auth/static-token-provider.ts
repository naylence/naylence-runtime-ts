import type { Token } from './token.js';
import type { IdentityExposingTokenProvider } from './token-provider.js';
import type { AuthIdentity } from './auth-identity.js';

export interface StaticTokenProviderOptions {
  token: string;
  expiresAt?: number | string | Date | null;
}

type StaticTokenProviderOptionsInput =
  | StaticTokenProviderOptions
  | string
  | (StaticTokenProviderOptions & Record<string, unknown>)
  | Record<string, unknown>;

function normalizeExpiresAt(
  expiresAt?: number | string | Date | null
): number | undefined {
  if (expiresAt === null || expiresAt === undefined) {
    return undefined;
  }

  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt)) {
      throw new TypeError('expiresAt must be a finite number when provided');
    }
    return expiresAt;
  }

  if (expiresAt instanceof Date) {
    const time = expiresAt.getTime();
    if (Number.isNaN(time)) {
      throw new TypeError('expiresAt Date must be valid');
    }
    return time;
  }

  if (typeof expiresAt === 'string') {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) {
      throw new TypeError(
        'expiresAt string must be ISO-8601 or epoch milliseconds'
      );
    }
    return parsed;
  }

  throw new TypeError(
    'expiresAt must be a number, string, Date, or null/undefined'
  );
}

export class StaticTokenProvider implements IdentityExposingTokenProvider {
  private readonly token: Token;

  constructor(input: StaticTokenProviderOptionsInput) {
    const options = normalizeOptions(input);
    if (!options || typeof options.token !== 'string') {
      throw new TypeError('StaticTokenProvider requires a string token value');
    }

    this.token = {
      value: options.token,
    };

    const normalizedExpiresAt = normalizeExpiresAt(options.expiresAt);
    if (normalizedExpiresAt !== undefined) {
      this.token.expiresAt = normalizedExpiresAt;
    }
  }

  public async getToken(): Promise<Token> {
    return { ...this.token };
  }

  public async getIdentity(): Promise<AuthIdentity | undefined> {
    const tokenValue = this.token.value;
    const parts = tokenValue.split('.');
    if (parts.length !== 3) {
      return undefined;
    }

    try {
      const payloadSegment = parts[1];
      // Fix padding for base64url
      const padding = '='.repeat((4 - (payloadSegment.length % 4)) % 4);
      const base64 = (payloadSegment + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

      let jsonString: string;
      if (typeof Buffer !== 'undefined') {
        jsonString = Buffer.from(base64, 'base64').toString('utf-8');
      } else if (typeof atob === 'function') {
        jsonString = atob(base64);
        try {
          jsonString = decodeURIComponent(
            jsonString
              .split('')
              .map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
              })
              .join('')
          );
        } catch {
          // ignore
        }
      } else {
        return undefined;
      }

      const payload = JSON.parse(jsonString);
      if (payload && typeof payload.sub === 'string') {
        return { subject: payload.sub, claims: payload };
      }
    } catch {
      // ignore decoding errors
    }
    return undefined;
  }
}

function normalizeOptions(
  input: StaticTokenProviderOptionsInput
): StaticTokenProviderOptions {
  if (input === null || input === undefined) {
    throw new TypeError('StaticTokenProvider requires a string token value');
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    return { token: trimmed };
  }

  if (typeof input !== 'object') {
    throw new TypeError('StaticTokenProvider requires a string token value');
  }

  const candidate = input as StaticTokenProviderOptions &
    Record<string, unknown>;
  const tokenCandidate =
    candidate.token ??
    candidate.tokenValue ??
    candidate.token_value ??
    candidate.value;

  if (typeof tokenCandidate !== 'string') {
    throw new TypeError('StaticTokenProvider requires a string token value');
  }

  const expiresCandidate =
    candidate.expiresAt ??
    candidate.expires_at ??
    candidate.expiration ??
    candidate.expiration_at;

  let expiresAt: number | string | Date | null | undefined;
  if (expiresCandidate !== undefined) {
    if (
      typeof expiresCandidate === 'string' ||
      typeof expiresCandidate === 'number' ||
      expiresCandidate instanceof Date ||
      expiresCandidate === null
    ) {
      expiresAt = expiresCandidate;
    } else {
      throw new TypeError(
        'expiresAt must be a number, string, Date, or null/undefined'
      );
    }
  }

  return {
    token: tokenCandidate,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
