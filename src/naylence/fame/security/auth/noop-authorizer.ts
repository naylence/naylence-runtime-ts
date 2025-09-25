import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from 'naylence-core';
import { createAuthorizationContext } from 'naylence-core';

import type { Authorizer } from './authorizer.js';
import type { NodeLike } from '../../node/node-like.js';

function isAuthorizationContext(value: unknown): value is AuthorizationContext {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'authenticated' in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).authenticated === 'boolean'
  );
}

function buildAuthorizationContext(
  overrides: Partial<AuthorizationContext> = {}
): AuthorizationContext {
  const { helper: _helper, ...rest } = overrides as AuthorizationContext & { helper?: unknown };
  const sanitized = { ...rest } as Partial<AuthorizationContext>;
  const authenticated = true;
  const authorized = true;
  const authMethod = sanitized.authMethod ?? 'noop_authorizer';

  delete sanitized.authenticated;
  delete sanitized.authorized;
  delete sanitized.authMethod;

  return createAuthorizationContext({
    ...sanitized,
    authenticated,
    authorized,
    authMethod,
  });
}

export class NoopAuthorizer implements Authorizer {
  public async authenticate(_credentials: string | Uint8Array): Promise<AuthorizationContext> {
    return buildAuthorizationContext();
  }

  public async authorize(
    _node: NodeLike,
    _envelope: FameEnvelope,
    context?: FameDeliveryContext | AuthorizationContext
  ): Promise<AuthorizationContext> {
    if (!context) {
      return buildAuthorizationContext();
    }

    if (isAuthorizationContext(context)) {
      return buildAuthorizationContext(context);
    }

    const authorization = context.security?.authorization;
    if (authorization) {
      return buildAuthorizationContext(authorization);
    }

    return buildAuthorizationContext();
  }

  public async validateNodeAttachRequest(
    _node: NodeLike,
    frame: NodeAttachFrame,
    authContext?: AuthorizationContext
  ): Promise<AuthorizationContext> {
    return buildAuthorizationContext({
      ...authContext,
      principal: authContext?.principal ?? frame.systemId,
    });
  }
}
