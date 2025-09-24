const POOL_WILDCARD_PREFIX = '*.';

export function isPoolLogical(logical: string | null | undefined): boolean {
  if (!logical) {
    return false;
  }
  return logical.startsWith(POOL_WILDCARD_PREFIX);
}

export function matchesPoolLogical(logical: string, poolPattern: string): boolean {
  if (!isPoolLogical(poolPattern)) {
    return false;
  }

  const suffix = poolPattern.slice(POOL_WILDCARD_PREFIX.length);
  if (!suffix) {
    return false;
  }

  return (
    (logical.endsWith(`.${suffix}`) && logical !== suffix) || logical === suffix
  );
}
