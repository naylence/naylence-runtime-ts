import type { NodeLike } from '../node/node-like.js';

export interface Registerable {
  onRegister?(node: NodeLike): Promise<void> | void;
  onUnregister?(): Promise<void> | void;
}

export function isRegisterable(value: unknown): value is Registerable {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    onRegister?: unknown;
    onUnregister?: unknown;
  };

  if (
    candidate.onRegister !== undefined &&
    typeof candidate.onRegister !== 'function'
  ) {
    return false;
  }

  if (
    candidate.onUnregister !== undefined &&
    typeof candidate.onUnregister !== 'function'
  ) {
    return false;
  }

  return (
    typeof candidate.onRegister === 'function' ||
    typeof candidate.onUnregister === 'function'
  );
}
