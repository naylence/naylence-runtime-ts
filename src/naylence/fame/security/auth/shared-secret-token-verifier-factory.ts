import { registerFactory } from "naylence-factory";

import type { CredentialProvider } from "../credential/credential-provider.js";
import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from "../credential/credential-provider-factory.js";
import { normalizeSecretSource, type SecretSourceType } from "../credential/secret-source.js";
import type { TokenVerifier } from "./token-verifier.js";
import {
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  TokenVerifierFactory,
  type TokenVerifierConfig,
} from "./token-verifier-factory.js";
import {
  SharedSecretTokenVerifier,
  type SharedSecretTokenVerifierOptions,
} from "./shared-secret-token-verifier.js";

export interface SharedSecretTokenVerifierConfig extends TokenVerifierConfig {
  type: "SharedSecretTokenVerifier";
  secret?: SecretSourceType;
  principal?: string;
}

interface NormalizedSharedSecretVerifierConfig {
  secretConfig: CredentialProviderConfig | Record<string, unknown>;
  principal?: string;
}

function normalizeConfig(
  config?: SharedSecretTokenVerifierConfig | Record<string, unknown> | null
): NormalizedSharedSecretVerifierConfig {
  const candidate = (config ?? {}) as SharedSecretTokenVerifierConfig & Record<string, unknown>;
  const secretSource: SecretSourceType = candidate.secret ?? "env://SHARED_SECRET";

  const normalized: NormalizedSharedSecretVerifierConfig = {
    secretConfig: normalizeSecretSource(secretSource),
  };

  if (typeof candidate.principal === "string" && candidate.principal.length > 0) {
    normalized.principal = candidate.principal;
  }

  return normalized;
}

export class SharedSecretTokenVerifierFactory extends TokenVerifierFactory<SharedSecretTokenVerifierConfig> {
  public readonly type = "SharedSecretTokenVerifier";

  public async create(
    config?: SharedSecretTokenVerifierConfig | Record<string, unknown> | null
  ): Promise<TokenVerifier> {
    const normalized = normalizeConfig(config);
    const credentialProvider = (await CredentialProviderFactory.createCredentialProvider(
      normalized.secretConfig
    )) as CredentialProvider;

    const options = {
      credentialProvider,
    } as SharedSecretTokenVerifierOptions;

    if (normalized.principal) {
      options.principal = normalized.principal;
    }

    return new SharedSecretTokenVerifier(options);
  }
}

registerFactory<TokenVerifier, SharedSecretTokenVerifierConfig>(
  TOKEN_VERIFIER_FACTORY_BASE_TYPE,
  "SharedSecretTokenVerifier",
  SharedSecretTokenVerifierFactory
);
