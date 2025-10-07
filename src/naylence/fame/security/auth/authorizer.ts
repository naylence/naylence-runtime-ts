import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
} from 'naylence-core';
import type { NodeLike } from '../../node/node-like.js';

export interface Authorizer {
  authenticate(
    credentials: string | Uint8Array
  ): Promise<AuthorizationContext | undefined>;

  authorize(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<AuthorizationContext | undefined>;

  createReverseAuthorizationConfig?(
    node: NodeLike
  ):
    | Promise<Record<string, unknown> | undefined>
    | Record<string, unknown>
    | undefined;
}
