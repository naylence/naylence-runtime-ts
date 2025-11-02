import { createAuthorizationContext } from '@naylence/core';
import type { AuthorizationContext } from '@naylence/core';

import {
  credentialToString,
  type CredentialProvider,
} from '../credential/credential-provider.js';
import type { TokenVerifier } from './token-verifier.js';

export interface SharedSecretTokenVerifierOptions {
  credentialProvider: CredentialProvider;
  principal?: string;
}

type SharedSecretTokenVerifierOptionsInput =
  | SharedSecretTokenVerifierOptions
  | CredentialProvider
  | (SharedSecretTokenVerifierOptions & Record<string, unknown>)
  | Record<string, unknown>;

function isCredentialProvider(value: unknown): value is CredentialProvider {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as CredentialProvider).get === 'function'
  );
}

function normalizeOptions(
  input: SharedSecretTokenVerifierOptionsInput
): SharedSecretTokenVerifierOptions {
  if (isCredentialProvider(input)) {
    return { credentialProvider: input };
  }

  const candidate = input as SharedSecretTokenVerifierOptions &
    Record<string, unknown>;

  const credentialProviderCandidate =
    candidate.credentialProvider ?? candidate.credential_provider;

  if (!isCredentialProvider(credentialProviderCandidate)) {
    throw new Error(
      'SharedSecretTokenVerifier requires a credentialProvider option'
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

export class SharedSecretTokenVerifier implements TokenVerifier {
  private readonly credentialProvider: CredentialProvider;
  private readonly principal: string;

  constructor(options: SharedSecretTokenVerifierOptionsInput) {
    const normalized = normalizeOptions(options);

    this.credentialProvider = normalized.credentialProvider;
    this.principal = normalized.principal ?? '*';
  }

  public async verify(
    token: string,
    options?: { expectedAudience?: string }
  ): Promise<AuthorizationContext> {
    const expectedSecret = credentialToString(
      await this.credentialProvider.get()
    );
    if (!expectedSecret) {
      throw new Error('Shared secret credential provider returned empty value');
    }

    if (token !== expectedSecret) {
      throw new Error('Invalid shared secret token');
    }

    const claims: Record<string, unknown> = {
      sub: this.principal,
      mode: 'shared-secret',
      valid: true,
    };

    if (options?.expectedAudience) {
      claims.aud = options.expectedAudience;
    }

    return createAuthorizationContext({
      authenticated: true,
      authorized: true,
      principal: this.principal,
      claims,
      authMethod: 'shared_secret',
    });
  }
}
