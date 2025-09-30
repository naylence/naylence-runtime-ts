import { registerFactory } from "naylence-factory";

import type { Authorizer } from "./authorizer.js";
import {
  AUTHORIZER_FACTORY_BASE_TYPE,
  AuthorizerFactory,
  type AuthorizerConfig,
} from "./authorizer-factory.js";
import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from "../credential/credential-provider-factory.js";
import { normalizeSecretSource, type SecretSourceType } from "../credential/secret-source.js";
import { SharedSecretAuthorizer } from "./shared-secret-authorizer.js";

export interface SharedSecretAuthorizerConfig extends AuthorizerConfig {
  type: "SharedSecretAuthorizer";
  secret?: SecretSourceType;
}

interface NormalizedSharedSecretAuthorizerConfig {
  secretConfig: CredentialProviderConfig | Record<string, unknown>;
}

function normalizeConfig(
  config?: SharedSecretAuthorizerConfig | Record<string, unknown> | null
): NormalizedSharedSecretAuthorizerConfig {
  if (!config) {
    throw new Error("SharedSecretAuthorizer requires configuration");
  }

  const source = config as SharedSecretAuthorizerConfig & Record<string, unknown>;
  const secretSource: SecretSourceType = source.secret ?? "env://SHARED_SECRET";

  return {
    secretConfig: normalizeSecretSource(secretSource),
  };
}

export class SharedSecretAuthorizerFactory extends AuthorizerFactory<SharedSecretAuthorizerConfig> {
  public readonly type = "SharedSecretAuthorizer";

  public async create(
    config?: SharedSecretAuthorizerConfig | Record<string, unknown> | null
  ): Promise<Authorizer> {
    const normalized = normalizeConfig(config);

    const credentialProvider = await CredentialProviderFactory.createCredentialProvider(
      normalized.secretConfig
    );

    return new SharedSecretAuthorizer(credentialProvider);
  }
}

registerFactory<Authorizer, SharedSecretAuthorizerConfig>(
  AUTHORIZER_FACTORY_BASE_TYPE,
  "SharedSecretAuthorizer",
  SharedSecretAuthorizerFactory
);
