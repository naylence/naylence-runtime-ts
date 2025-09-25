export type AttachmentKey = Record<string, unknown>;

export interface KeyInfoOptions {
  readonly kid?: string | null;
  readonly expiresAt?: Date | string | number | null;
  readonly notBefore?: Date | string | number | null;
  readonly hasCertificate?: boolean;
  readonly certSubject?: string | null;
  readonly certIssuer?: string | null;
}

function toDateOrNull(value?: Date | string | number | null): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : null;
  }

  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp);
    }

    throw new Error(`Invalid date string provided: ${value}`);
  }

  return null;
}

export class KeyInfo {
  public readonly kid: string | null;
  public readonly expiresAt: Date | null;
  public readonly notBefore: Date | null;
  public readonly hasCertificate: boolean;
  public readonly certSubject: string | null;
  public readonly certIssuer: string | null;

  constructor(options: KeyInfoOptions = {}) {
    this.kid = options.kid ?? null;
    this.expiresAt = toDateOrNull(options.expiresAt);
    this.notBefore = toDateOrNull(options.notBefore);
    this.hasCertificate = options.hasCertificate ?? false;
    this.certSubject = options.certSubject ?? null;
    this.certIssuer = options.certIssuer ?? null;
  }
}

export type AttachmentKeyValidationResult = readonly [boolean, string];

export class KeyValidationError extends Error {
  public readonly code: string;
  public readonly kid: string | null;
  public readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      kid?: string | null;
      details?: Record<string, unknown> | null;
    } = {}
  ) {
    super(message);
    this.name = 'KeyValidationError';
    this.code = code;
    this.kid = options.kid ?? null;
    this.details = options.details ? { ...options.details } : {};
  }
}

export abstract class AttachmentKeyValidator {
  public abstract validateKey(key: AttachmentKey): Promise<KeyInfo>;

  public async validateKeys(keys?: Iterable<AttachmentKey> | null): Promise<KeyInfo[]> {
    const infos: KeyInfo[] = [];

    if (!keys) {
      return infos;
    }

    for (const key of keys) {
      const info = await this.validateKey(key);
      infos.push(info);
    }

    return infos;
  }

  public abstract validateChildAttachmentLogicals(
    childKeys: readonly AttachmentKey[] | null | undefined,
    authorizedLogicals: readonly string[] | null | undefined,
    childId: string
  ): Promise<AttachmentKeyValidationResult>;
}
