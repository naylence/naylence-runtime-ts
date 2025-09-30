import { MAX_OAUTH2_TTL_SEC, TTL_NEVER_EXPIRES } from "../constants/ttl-constants.js";

export class TtlValidationError extends Error {}

type Numeric = number;

export function validateTtlSec(
  ttlSec: Numeric | null | undefined,
  {
    min,
    max,
    allowNeverExpires,
    context,
  }: {
    min: Numeric;
    max?: Numeric;
    allowNeverExpires?: boolean;
    context: string;
  }
): Numeric | null | undefined {
  if (ttlSec == null) {
    return ttlSec;
  }

  if (ttlSec === TTL_NEVER_EXPIRES) {
    if (allowNeverExpires) {
      return ttlSec;
    }
    throw new TtlValidationError(`${context} cannot be set to never expire (0)`);
  }

  if (ttlSec < 0) {
    throw new TtlValidationError(`${context} cannot be negative: ${ttlSec}`);
  }

  if (ttlSec < min) {
    throw new TtlValidationError(
      `${context} is too small: ${ttlSec} seconds (minimum: ${min} seconds)`
    );
  }

  if (max !== undefined && ttlSec > max) {
    throw new TtlValidationError(
      `${context} is too large: ${ttlSec} seconds (maximum: ${max} seconds)`
    );
  }

  return ttlSec;
}

export function validateJwtTokenTtlSec(
  ttlSec: Numeric | null | undefined
): Numeric | null | undefined {
  return validateTtlSec(ttlSec, {
    min: 60,
    max: MAX_OAUTH2_TTL_SEC,
    allowNeverExpires: false,
    context: "JWT token TTL",
  });
}

export function validateOAuth2TtlSec(
  ttlSec: Numeric | null | undefined
): Numeric | null | undefined {
  return validateTtlSec(ttlSec, {
    min: 60,
    max: MAX_OAUTH2_TTL_SEC,
    allowNeverExpires: false,
    context: "OAuth2 authorization TTL",
  });
}

export function validateCacheTtlSec(
  ttlSec: Numeric | null | undefined
): Numeric | null | undefined {
  return validateTtlSec(ttlSec, {
    min: 1,
    max: 3600,
    allowNeverExpires: true,
    context: "Cache TTL",
  });
}

export function validateKeyCorrelationTtlSec(
  ttlSec: Numeric | null | undefined
): Numeric | null | undefined {
  return validateTtlSec(ttlSec, {
    min: 0.1,
    max: 300,
    allowNeverExpires: false,
    context: "Key correlation TTL",
  });
}
