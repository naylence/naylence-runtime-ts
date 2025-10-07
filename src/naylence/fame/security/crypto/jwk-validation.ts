export const VALID_KEY_USES = new Set(['sig', 'enc']);

export const REQUIRED_FIELDS_BY_KTY: Record<string, ReadonlySet<string>> = {
  RSA: new Set(['kty', 'n', 'e']),
  EC: new Set(['kty', 'crv', 'x', 'y']),
  OKP: new Set(['kty', 'crv', 'x']),
};

export const VALID_CURVES_BY_KTY: Record<string, ReadonlySet<string>> = {
  EC: new Set(['P-256', 'P-384', 'P-521']),
  OKP: new Set(['Ed25519', 'Ed448', 'X25519', 'X448']),
};

export type JsonWebKey = Record<string, unknown>;

export class JWKValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JWKValidationError';
  }
}

export function validateJwkUseField(jwk: JsonWebKey): string {
  const use = jwk?.use;

  if (!use) {
    throw new JWKValidationError(
      `JWK missing required 'use' field: ${String(jwk?.kid ?? 'unknown')}`
    );
  }

  if (typeof use !== 'string') {
    throw new JWKValidationError(
      `JWK 'use' field must be a string: ${String(jwk?.kid ?? 'unknown')}`
    );
  }

  if (!VALID_KEY_USES.has(use)) {
    throw new JWKValidationError(
      `JWK has invalid 'use' field '${use}'. Valid values: ${Array.from(VALID_KEY_USES).join(', ')}`
    );
  }

  return use;
}

export function validateJwkStructure(jwk: JsonWebKey): void {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) {
    throw new JWKValidationError('JWK must be a dictionary');
  }

  const kid = jwk.kid;
  if (!kid || typeof kid !== 'string') {
    throw new JWKValidationError(
      "JWK missing required 'kid' field or kid is not a string"
    );
  }

  const kty = jwk.kty;
  if (!kty || typeof kty !== 'string') {
    throw new JWKValidationError(
      `JWK ${kid} missing required 'kty' field or kty is not a string`
    );
  }

  const requiredFields = REQUIRED_FIELDS_BY_KTY[kty];
  if (!requiredFields) {
    throw new JWKValidationError(
      `JWK ${kid} has unsupported key type '${kty}'`
    );
  }

  const missingFields = Array.from(requiredFields).filter(
    (field) => !(field in jwk)
  );
  if (missingFields.length > 0) {
    throw new JWKValidationError(
      `JWK ${kid} missing required fields for ${kty}: ${missingFields.join(', ')}`
    );
  }

  if (kty === 'EC' || kty === 'OKP') {
    const crv = jwk.crv;
    if (!crv || typeof crv !== 'string') {
      throw new JWKValidationError(
        `JWK ${kid} missing required 'crv' field or crv is not a string`
      );
    }

    const validCurves = VALID_CURVES_BY_KTY[kty];
    if (validCurves && !validCurves.has(crv)) {
      throw new JWKValidationError(
        `JWK ${kid} has invalid curve '${crv}' for ${kty}. Valid curves: ${Array.from(validCurves).join(', ')}`
      );
    }
  }
}

export function validateJwkComplete(jwk: JsonWebKey): string {
  validateJwkStructure(jwk);
  const use = validateJwkUseField(jwk);

  const kty = jwk.kty;
  const crv = jwk.crv;
  const kid = (jwk.kid as string) ?? 'unknown';

  if (kty === 'OKP') {
    if (crv === 'X25519' && use !== 'enc') {
      throw new JWKValidationError(
        `JWK ${kid} is X25519 key but marked for use='${use}'. X25519 keys should have use='enc'`
      );
    }

    if ((crv === 'Ed25519' || crv === 'Ed448') && use !== 'sig') {
      throw new JWKValidationError(
        `JWK ${kid} is ${crv} key but marked for use='${use}'. ${crv} keys should have use='sig'`
      );
    }
  } else if (
    kty === 'RSA' ||
    (kty === 'EC' && (crv === 'P-256' || crv === 'P-384' || crv === 'P-521'))
  ) {
    if (use !== 'sig') {
      throw new JWKValidationError(
        `JWK ${kid} is ${kty} key but marked for use='${use}'. ${kty} keys should have use='sig'`
      );
    }
  }

  return use;
}

export function filterKeysByUse(keys: JsonWebKey[], use: string): JsonWebKey[] {
  if (!VALID_KEY_USES.has(use)) {
    throw new Error(
      `Invalid use value '${use}'. Valid values: ${Array.from(VALID_KEY_USES).join(', ')}`
    );
  }

  const filtered: JsonWebKey[] = [];

  for (const jwk of keys) {
    try {
      const validatedUse = validateJwkComplete(jwk);
      if (validatedUse === use) {
        if (use === 'enc') {
          validateEncryptionKey(jwk);
        } else if (use === 'sig') {
          validateSigningKey(jwk);
        }
        filtered.push(jwk);
      }
    } catch (error) {
      if (error instanceof JWKValidationError) {
        continue;
      }
      throw error;
    }
  }

  return filtered;
}

export function validateEncryptionKey(jwk: JsonWebKey): void {
  const use = validateJwkComplete(jwk);
  if (use !== 'enc') {
    throw new JWKValidationError(
      `JWK ${String(jwk.kid ?? 'unknown')} is not an encryption key (use=${use})`
    );
  }

  const kty = jwk.kty;
  const crv = jwk.crv;

  if (kty === 'OKP' && crv === 'X25519') {
    return;
  }

  throw new JWKValidationError(
    `JWK ${String(jwk.kid ?? 'unknown')} is not a supported encryption key type (kty=${String(kty)}, crv=${String(crv)}). Currently only X25519 keys are supported.`
  );
}

export function validateSigningKey(jwk: JsonWebKey): void {
  const use = validateJwkComplete(jwk);
  if (use !== 'sig') {
    throw new JWKValidationError(
      `JWK ${String(jwk.kid ?? 'unknown')} is not a signing key (use=${use})`
    );
  }

  const kty = jwk.kty;
  const crv = jwk.crv;

  if (kty === 'OKP' && (crv === 'Ed25519' || crv === 'Ed448')) {
    return;
  }

  if (kty === 'RSA') {
    return;
  }

  if (kty === 'EC' && (crv === 'P-256' || crv === 'P-384' || crv === 'P-521')) {
    return;
  }

  throw new JWKValidationError(
    `JWK ${String(jwk.kid ?? 'unknown')} is not a supported signing key type (kty=${String(kty)}, crv=${String(crv)}). Supported types: Ed25519/Ed448, RSA, ECDSA P-256/P-384/P-521.`
  );
}
