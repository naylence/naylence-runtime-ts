import type { Token } from './token.js';
import type { TokenProvider } from './token-provider.js';

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

export class StaticTokenProvider implements TokenProvider {
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

  const candidate = input as StaticTokenProviderOptions & Record<string, unknown>;
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
