export const GRANT_PURPOSE_NODE_ATTACH = 'node.attach' as const;

export type GrantPurpose = typeof GRANT_PURPOSE_NODE_ATTACH | string;

export interface Grant {
  /** Type of grant */
  type: string;
  /** Purpose of the grant (e.g., 'node.attach') */
  purpose: GrantPurpose;
  /** Additional grant attributes */
  [key: string]: unknown;
}

export function isGrant(candidate: unknown): candidate is Grant {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const grant = candidate as Record<string, unknown>;
  return typeof grant.type === 'string' && typeof grant.purpose === 'string';
}

export function assertGrant(
  candidate: unknown,
  message = 'Invalid grant object'
): asserts candidate is Grant {
  if (!isGrant(candidate)) {
    throw new TypeError(message);
  }
}
