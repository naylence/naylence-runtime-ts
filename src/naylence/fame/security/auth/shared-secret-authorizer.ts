import type {
  AuthorizationContext,
  FameDeliveryContext,
  FameEnvelope,
  NodeAttachFrame,
} from '@naylence/core';
import { createAuthorizationContext } from '@naylence/core';

import {
  credentialToString,
  type CredentialProvider,
} from '../credential/credential-provider.js';
import type { Authorizer } from './authorizer.js';
import type { NodeLike } from '../../node/node-like.js';

export interface SharedSecretAuthorizerOptions {
  credentialProvider: CredentialProvider;
  principal?: string;
}

type SharedSecretAuthorizerOptionsInput =
  | SharedSecretAuthorizerOptions
  | CredentialProvider
  | (SharedSecretAuthorizerOptions & Record<string, unknown>)
  | Record<string, unknown>;

function isCredentialProvider(value: unknown): value is CredentialProvider {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as CredentialProvider).get === 'function'
  );
}

function normalizeOptions(
  input: SharedSecretAuthorizerOptionsInput
): SharedSecretAuthorizerOptions {
  if (isCredentialProvider(input)) {
    return { credentialProvider: input };
  }

  const candidate = input as SharedSecretAuthorizerOptions &
    Record<string, unknown>;

  const credentialProviderCandidate =
    candidate.credentialProvider ?? candidate.credential_provider;

  if (!isCredentialProvider(credentialProviderCandidate)) {
    throw new Error(
      'SharedSecretAuthorizer requires a credentialProvider option'
    );
  }

  const principalCandidateRaw =
    candidate.principal ??
    (typeof candidate.principal_id === 'string'
      ? candidate.principal_id
      : typeof candidate.principal_name === 'string'
        ? candidate.principal_name
        : undefined);
  const principalCandidate =
    typeof principalCandidateRaw === 'string'
      ? principalCandidateRaw.trim()
      : undefined;

  return {
    credentialProvider: credentialProviderCandidate,
    ...(principalCandidate && principalCandidate.length > 0
      ? { principal: principalCandidate }
      : {}),
  };
}

function decodeCredentials(credentials: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(credentials);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(credentials).toString('utf-8');
  }

  throw new Error(
    'Unable to decode credential bytes without TextDecoder support'
  );
}

function normalizeToken(credentials: string | Uint8Array): string | undefined {
  const raw =
    typeof credentials === 'string'
      ? credentials
      : decodeCredentials(credentials);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.toLowerCase().startsWith('bearer ')) {
    const candidate = trimmed.slice(7).trim();
    return candidate.length > 0 ? candidate : undefined;
  }

  return trimmed;
}

function isAuthorizationContext(value: unknown): value is AuthorizationContext {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'authenticated' in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).authenticated === 'boolean'
  );
}

export class SharedSecretAuthorizer implements Authorizer {
  private readonly credentialProvider: CredentialProvider;
  private readonly principal: string;

  constructor(options: SharedSecretAuthorizerOptionsInput) {
    const normalized = normalizeOptions(options);

    this.credentialProvider = normalized.credentialProvider;
    this.principal = normalized.principal ?? 'shared_secret_user';
  }

  public async authenticate(
    credentials: string | Uint8Array
  ): Promise<AuthorizationContext | undefined> {
    const expectedSecret = credentialToString(
      await this.credentialProvider.get()
    );
    if (!expectedSecret) {
      throw new Error('Shared secret not configured');
    }

    const token = normalizeToken(credentials);
    if (!token) {
      return undefined;
    }

    if (token !== expectedSecret) {
      return undefined;
    }

    return createAuthorizationContext({
      authenticated: true,
      principal: this.principal,
      authMethod: 'shared_secret',
    });
  }

  public async authorize(
    _node: NodeLike,
    _envelope: FameEnvelope,
    context?: FameDeliveryContext | AuthorizationContext
  ): Promise<AuthorizationContext | undefined> {
    let authContext: AuthorizationContext | undefined;

    if (!context) {
      authContext = undefined;
    } else if (isAuthorizationContext(context)) {
      authContext = context;
    } else {
      authContext = context.security?.authorization;
    }

    if (!authContext || !authContext.authenticated) {
      return undefined;
    }

    if (authContext.authorized) {
      return authContext;
    }

    return createAuthorizationContext({
      ...authContext,
      authorized: true,
      authMethod: authContext.authMethod ?? 'shared_secret',
    });
  }

  public async validateNodeAttachRequest(
    node: NodeLike,
    frame: NodeAttachFrame,
    authContext?: AuthorizationContext
  ): Promise<AuthorizationContext | undefined> {
    if (!authContext || !authContext.authenticated) {
      return undefined;
    }

    const claims = { ...(authContext.claims ?? {}) } as Record<string, unknown>;

    claims.sub = claims.sub ?? frame.systemId;
    claims.aud = claims.aud ?? node.id;
    claims.instance_id = claims.instance_id ?? frame.instanceId;

    if (frame.assignedPath) {
      claims.assigned_path = frame.assignedPath;
    }

    if (Array.isArray(frame.capabilities)) {
      claims.accepted_capabilities = [...frame.capabilities];
    }

    if (Array.isArray(frame.acceptedLogicals)) {
      claims.accepted_logicals = [...frame.acceptedLogicals];
    }

    return createAuthorizationContext({
      ...authContext,
      claims,
      authorized: true,
      authMethod: authContext.authMethod ?? 'shared_secret',
      principal: authContext.principal ?? frame.systemId,
    });
  }
}
