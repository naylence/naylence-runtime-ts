import { registerFactory } from "naylence-factory";
import type { AuthInjectionStrategy } from "../../security/auth/auth-injection-strategy.js";
import {
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from "../../security/auth/auth-injection-strategy-factory.js";
import "../../security/auth/no-auth-injection-strategy-factory.js";
import {
  WelcomeServiceClient,
  type WelcomeServiceClientOptions,
} from "./welcome-service-client.js";
import {
  ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  AdmissionClientFactory,
  type AdmissionConfig,
} from "./admission-client-factory.js";
import type { AdmissionClient } from "./admission-client.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface WelcomeServiceClientConfig extends AdmissionConfig {
  type: "WelcomeServiceClient";
  url: string;
  supportedTransports: string[];
  auth?: AuthInjectionStrategyConfig | null;
  isRoot?: boolean;
  fetchImpl?: FetchLike;
}

interface NormalizedWelcomeServiceClientConfig {
  url: string;
  supportedTransports: string[];
  authConfig: AuthInjectionStrategyConfig | null;
  isRoot: boolean;
  fetchImpl?: FetchLike;
}

export class WelcomeServiceClientFactory extends AdmissionClientFactory<WelcomeServiceClientConfig> {
  public readonly type = "WelcomeServiceClient";

  public async create(
    config?: WelcomeServiceClientConfig | Record<string, unknown> | null
  ): Promise<AdmissionClient> {
    if (!config) {
      throw new Error("WelcomeServiceClient configuration is required");
    }

    const normalized = normalizeConfig(config);

    const authStrategy = await createAuthStrategy(normalized.authConfig);

    const clientOptions: WelcomeServiceClientOptions = {
      hasUpstream: !normalized.isRoot,
      url: normalized.url,
      supportedTransports: normalized.supportedTransports,
      ...(normalized.fetchImpl ? { fetchImpl: normalized.fetchImpl } : {}),
      ...(authStrategy ? { authStrategy } : {}),
    };

    const client = new WelcomeServiceClient(clientOptions);

    if (authStrategy) {
      await authStrategy.apply(client);
    }

    return client;
  }
}

function normalizeConfig(
  config: WelcomeServiceClientConfig | Record<string, unknown>
): NormalizedWelcomeServiceClientConfig {
  const source = config as WelcomeServiceClientConfig & Record<string, unknown>;

  const urlCandidate = typeof source.url === "string" ? source.url.trim() : "";
  if (!urlCandidate) {
    throw new Error("WelcomeServiceClient configuration requires a non-empty url");
  }

  const transports = Array.isArray(source.supportedTransports)
    ? source.supportedTransports.filter(
        (value) => typeof value === "string" && value.trim().length > 0
      )
    : [];
  if (transports.length === 0) {
    throw new Error("WelcomeServiceClient configuration requires supportedTransports");
  }

  const authConfig = source.auth ?? null;

  const isRoot =
    typeof source.isRoot === "boolean"
      ? source.isRoot
      : typeof source.is_root === "boolean"
        ? source.is_root
        : false;

  const fetchImpl = source.fetchImpl as FetchLike | undefined;

  return {
    url: urlCandidate,
    supportedTransports: transports,
    authConfig,
    isRoot,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

async function createAuthStrategy(
  config: AuthInjectionStrategyConfig | null
): Promise<AuthInjectionStrategy | undefined> {
  if (!config) {
    return undefined;
  }

  if (!config.type) {
    throw new Error("Auth injection strategy configuration requires a type");
  }

  return AuthInjectionStrategyFactory.createAuthInjectionStrategy(config);
}

registerFactory<AdmissionClient, WelcomeServiceClientConfig>(
  ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  "WelcomeServiceClient",
  WelcomeServiceClientFactory
);
