import { safeImport } from '../../util/lazy-import.js';
import type { CredentialProvider } from '../credential/credential-provider.js';
import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from '../credential/credential-provider-factory.js';
import {
  normalizeSecretSource,
  type SecretSourceType,
} from '../credential/secret-source.js';
import type { TokenVerifier } from './token-verifier.js';
import {
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from './token-verifier-factory.js';
import type { SharedSecretTokenVerifierOptions } from './shared-secret-token-verifier.js';

export interface SharedSecretTokenVerifierConfig extends TokenVerifierConfig {
  type: 'SharedSecretTokenVerifier';
  secret?: SecretSourceType;
  principal?: string;
}

interface NormalizedSharedSecretVerifierConfig {
  secretConfig: CredentialProviderConfig | Record<string, unknown>;
  principal?: string;
}

type SharedSecretTokenVerifierModule =
  typeof import('./shared-secret-token-verifier.js');

let sharedSecretTokenVerifierModulePromise: Promise<SharedSecretTokenVerifierModule> | null =
  null;

async function getSharedSecretTokenVerifierModule(): Promise<SharedSecretTokenVerifierModule> {
  if (!sharedSecretTokenVerifierModulePromise) {
    sharedSecretTokenVerifierModulePromise = safeImport(
      () => import('./shared-secret-token-verifier.js'),
      'shared-secret-token-verifier'
    );
  }

  return sharedSecretTokenVerifierModulePromise;
}

function normalizeConfig(
  config?: SharedSecretTokenVerifierConfig | Record<string, unknown> | null
): NormalizedSharedSecretVerifierConfig {
  const candidate = (config ?? {}) as SharedSecretTokenVerifierConfig &
    Record<string, unknown>;
  const record = candidate as Record<string, unknown>;

  let secretSource = candidate.secret as SecretSourceType | undefined;
  if (secretSource === undefined && record.secret_provider !== undefined) {
    secretSource = record.secret_provider as SecretSourceType;
  }
  if (secretSource === undefined && record.secret_source !== undefined) {
    secretSource = record.secret_source as SecretSourceType;
  }
  if (
    secretSource === undefined &&
    record.secret_provider_config !== undefined
  ) {
    secretSource = record.secret_provider_config as SecretSourceType;
  }

  if (secretSource === undefined) {
    secretSource = 'env://SHARED_SECRET';
  }

  const normalized: NormalizedSharedSecretVerifierConfig = {
    secretConfig: normalizeSecretSource(secretSource),
  };

  const principalCandidateRaw =
    candidate.principal ??
    (typeof record.principal_id === 'string'
      ? record.principal_id
      : typeof record.principal_name === 'string'
        ? record.principal_name
        : undefined);

  if (
    typeof principalCandidateRaw === 'string' &&
    principalCandidateRaw.trim().length > 0
  ) {
    normalized.principal = principalCandidateRaw.trim();
  }

  return normalized;
}

export const FACTORY_META = {
  base: TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  key: 'SharedSecretTokenVerifier',
} as const;

export class SharedSecretTokenVerifierFactory extends TokenVerifierFactory<SharedSecretTokenVerifierConfig> {
  public readonly type = 'SharedSecretTokenVerifier';

  public async create(
    config?: SharedSecretTokenVerifierConfig | Record<string, unknown> | null
  ): Promise<TokenVerifier> {
    const normalized = normalizeConfig(config);
    const credentialProvider =
      (await CredentialProviderFactory.createCredentialProvider(
        normalized.secretConfig
      )) as CredentialProvider;

    const options = {
      credentialProvider,
    } as SharedSecretTokenVerifierOptions;

    if (normalized.principal) {
      options.principal = normalized.principal;
    }

    const { SharedSecretTokenVerifier } =
      await getSharedSecretTokenVerifierModule();

    return new SharedSecretTokenVerifier(options);
  }
}

export default SharedSecretTokenVerifierFactory;
