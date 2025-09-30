import { registerFactory } from "naylence-factory";

import {
  CredentialProviderFactory,
  type CredentialProviderConfig,
} from "../credential/credential-provider-factory.js";
import { normalizeSecretSource, type SecretSourceType } from "../credential/secret-source.js";
import { safeImport } from "../../util/lazy-import.js";
import type { TokenProvider } from "./token-provider.js";
import {
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  TokenProviderFactory,
  type TokenProviderConfig,
} from "./token-provider-factory.js";
import type { OAuth2ClientCredentialsTokenProviderOptions } from "./oauth2-client-credentials-token-provider.js";

type OAuth2ClientCredentialsTokenProviderModule = typeof import("./oauth2-client-credentials-token-provider.js");

let oauth2ClientCredentialsTokenProviderModulePromise: Promise<OAuth2ClientCredentialsTokenProviderModule> | null = null;
async function getOAuth2ClientCredentialsTokenProviderModule(): Promise<OAuth2ClientCredentialsTokenProviderModule> {
  if (!oauth2ClientCredentialsTokenProviderModulePromise) {
    oauth2ClientCredentialsTokenProviderModulePromise = safeImport(
      () => import("./oauth2-client-credentials-token-provider.js"),
      "oauth2-client-credentials-token-provider"
    );
  }

  return oauth2ClientCredentialsTokenProviderModulePromise;
}

export interface OAuth2ClientCredentialsTokenProviderConfig extends TokenProviderConfig {
  type: "OAuth2ClientCredentialsTokenProvider";
  tokenUrl: string;
  clientId: SecretSourceType;
  clientSecret: SecretSourceType;
  scopes?: string[];
  audience?: string;
}

interface NormalizedOAuth2Config {
  tokenUrl: string;
  clientIdConfig: CredentialProviderConfig | Record<string, unknown>;
  clientSecretConfig: CredentialProviderConfig | Record<string, unknown>;
  scopes: string[];
  audience?: string;
}

function normalizeConfig(
  config?: OAuth2ClientCredentialsTokenProviderConfig | Record<string, unknown> | null
): NormalizedOAuth2Config {
  if (!config) {
    throw new Error("OAuth2ClientCredentialsTokenProvider requires configuration");
  }

  const candidate = config as OAuth2ClientCredentialsTokenProviderConfig & Record<string, unknown>;
  if (typeof candidate.tokenUrl !== "string" || candidate.tokenUrl.length === 0) {
    throw new Error("OAuth2ClientCredentialsTokenProvider tokenUrl must be a non-empty string");
  }

  const clientIdSource: SecretSourceType = candidate.clientId;
  const clientSecretSource: SecretSourceType = candidate.clientSecret;

  const scopes = Array.isArray(candidate.scopes)
    ? candidate.scopes.filter(
        (scope): scope is string => typeof scope === "string" && scope.length > 0
      )
    : [];

  const normalized: NormalizedOAuth2Config = {
    tokenUrl: candidate.tokenUrl,
    clientIdConfig: normalizeSecretSource(clientIdSource),
    clientSecretConfig: normalizeSecretSource(clientSecretSource),
    scopes,
  };

  if (typeof candidate.audience === "string" && candidate.audience.length > 0) {
    normalized.audience = candidate.audience;
  }

  return normalized;
}

export class OAuth2ClientCredentialsTokenProviderFactory extends TokenProviderFactory<OAuth2ClientCredentialsTokenProviderConfig> {
  public readonly type = "OAuth2ClientCredentialsTokenProvider";

  public async create(
    config?: OAuth2ClientCredentialsTokenProviderConfig | Record<string, unknown> | null
  ): Promise<TokenProvider> {
    const normalized = normalizeConfig(config);

    const [clientIdProvider, clientSecretProvider] = await Promise.all([
      CredentialProviderFactory.createCredentialProvider(normalized.clientIdConfig),
      CredentialProviderFactory.createCredentialProvider(normalized.clientSecretConfig),
    ]);

    const options: OAuth2ClientCredentialsTokenProviderOptions = {
      tokenUrl: normalized.tokenUrl,
      clientIdProvider,
      clientSecretProvider,
      scopes: normalized.scopes,
    };

    if (normalized.audience) {
      options.audience = normalized.audience;
    }

    const { OAuth2ClientCredentialsTokenProvider } =
      await getOAuth2ClientCredentialsTokenProviderModule();

    return new OAuth2ClientCredentialsTokenProvider(options);
  }
}

registerFactory<TokenProvider, OAuth2ClientCredentialsTokenProviderConfig>(
  TOKEN_PROVIDER_FACTORY_BASE_TYPE,
  "OAuth2ClientCredentialsTokenProvider",
  OAuth2ClientCredentialsTokenProviderFactory
);
