import type { AuthorizerConfig } from '../security/auth/authorizer-factory.js';
import { AuthorizerFactory } from '../security/auth/authorizer-factory.js';
import type { TokenIssuerConfig } from '../security/auth/token-issuer-factory.js';
import { TokenIssuerFactory } from '../security/auth/token-issuer-factory.js';
import type { NodePlacementConfig } from '../placement/node-placement-strategy-factory.js';
import { NodePlacementStrategyFactory } from '../placement/node-placement-strategy-factory.js';
import type { TransportProvisionerConfig } from '../transport/transport-provisioner.js';
import { TransportProvisionerFactory } from '../transport/transport-provisioner.js';
import {
  DefaultWelcomeService,
  type DefaultWelcomeServiceOptions,
} from './default-welcome-service.js';
import type { WelcomeService } from './welcome-service.js';
import {
  WELCOME_SERVICE_FACTORY_BASE_TYPE,
  WelcomeServiceFactory,
  type WelcomeServiceConfig,
} from './welcome-service-factory.js';

export interface DefaultWelcomeServiceConfig extends WelcomeServiceConfig {
  type: 'DefaultWelcomeService';
  placement?: NodePlacementConfig | Record<string, unknown> | null;
  transport?: TransportProvisionerConfig | Record<string, unknown> | null;
  placementConfig?: NodePlacementConfig | Record<string, unknown> | null;
  placement_config?: NodePlacementConfig | Record<string, unknown> | null;
  transportProvisioner?:
    | TransportProvisionerConfig
    | Record<string, unknown>
    | null;
  transport_provisioner?:
    | TransportProvisionerConfig
    | Record<string, unknown>
    | null;
  tokenIssuer?: TokenIssuerConfig | Record<string, unknown> | null;
  token_issuer?: TokenIssuerConfig | Record<string, unknown> | null;
  authorizer?: AuthorizerConfig | Record<string, unknown> | null;
  authorizerConfig?: AuthorizerConfig | Record<string, unknown> | null;
  authorizer_config?: AuthorizerConfig | Record<string, unknown> | null;
  ttlSec?: number | null;
  ttl_sec?: number | null;
}

interface NormalizedDefaultWelcomeServiceConfig {
  placementConfig?: NodePlacementConfig | Record<string, unknown> | null;
  transportConfig?: TransportProvisionerConfig | Record<string, unknown> | null;
  tokenIssuerConfig?: TokenIssuerConfig | Record<string, unknown> | null;
  authorizerConfig?: AuthorizerConfig | Record<string, unknown> | null;
  ttlSec?: number;
}

export const FACTORY_META = {
  base: WELCOME_SERVICE_FACTORY_BASE_TYPE,
  key: 'DefaultWelcomeService',
} as const;

export class DefaultWelcomeServiceFactory extends WelcomeServiceFactory<DefaultWelcomeServiceConfig> {
  public readonly type = 'DefaultWelcomeService';
  public readonly isDefault = true;

  public async create(
    config?: DefaultWelcomeServiceConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<WelcomeService> {
    const normalized = normalizeConfig(config);

    const placementStrategy =
      await NodePlacementStrategyFactory.createNodePlacementStrategy(
        normalized.placementConfig ?? null,
        factoryArgs.length > 0 ? { factoryArgs } : undefined
      );

    const transportProvisioner =
      await TransportProvisionerFactory.createTransportProvisioner(
        normalized.transportConfig ?? null,
        factoryArgs.length > 0 ? { factoryArgs } : undefined
      );

    const tokenIssuer = await TokenIssuerFactory.createTokenIssuer(
      normalized.tokenIssuerConfig ?? null,
      factoryArgs.length > 0 ? { factoryArgs } : undefined
    );

    let authorizer = null;
    if (normalized.authorizerConfig) {
      authorizer =
        (await AuthorizerFactory.createAuthorizer(normalized.authorizerConfig, {
          factoryArgs,
        })) ?? null;
    }

    const options: DefaultWelcomeServiceOptions = {
      placementStrategy,
      transportProvisioner,
      tokenIssuer,
      authorizer,
    };

    if (normalized.ttlSec !== undefined) {
      options.ttlSec = normalized.ttlSec;
    }

    return new DefaultWelcomeService(options);
  }
}

function normalizeConfig(
  config?: DefaultWelcomeServiceConfig | Record<string, unknown> | null
): NormalizedDefaultWelcomeServiceConfig {
  if (!config) {
    return {};
  }

  const source = config as DefaultWelcomeServiceConfig &
    Record<string, unknown>;

  const ttlCandidate =
    typeof source.ttlSec === 'number'
      ? source.ttlSec
      : typeof source.ttl_sec === 'number'
        ? source.ttl_sec
        : undefined;

  const normalized: NormalizedDefaultWelcomeServiceConfig = {};

  const placementResult = resolveConfigEntry<
    NodePlacementConfig | Record<string, unknown> | null
  >(source, ['placement', 'placementConfig', 'placement_config']);
  if (placementResult.found && placementResult.value !== undefined) {
    normalized.placementConfig = placementResult.value ?? null;
  }

  const transportResult = resolveConfigEntry<
    TransportProvisionerConfig | Record<string, unknown> | null
  >(source, ['transport', 'transportProvisioner', 'transport_provisioner']);
  if (transportResult.found && transportResult.value !== undefined) {
    normalized.transportConfig = transportResult.value ?? null;
  }

  const tokenResult = resolveConfigEntry<
    TokenIssuerConfig | Record<string, unknown> | null
  >(source, ['tokenIssuer', 'token_issuer']);
  if (tokenResult.found && tokenResult.value !== undefined) {
    normalized.tokenIssuerConfig = tokenResult.value ?? null;
  }

  const authorizerResult = resolveConfigEntry<
    AuthorizerConfig | Record<string, unknown> | null
  >(source, ['authorizer', 'authorizerConfig', 'authorizer_config']);
  if (authorizerResult.found && authorizerResult.value !== undefined) {
    normalized.authorizerConfig = authorizerResult.value ?? null;
  }

  if (ttlCandidate !== undefined && Number.isFinite(ttlCandidate)) {
    normalized.ttlSec = ttlCandidate;
  }

  return normalized;
}

function resolveConfigEntry<T>(
  source: Record<string, unknown>,
  keys: string[]
): { found: boolean; value: T | null | undefined } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return {
        found: true,
        value: source[key] as T | null | undefined,
      };
    }
  }

  return { found: false, value: undefined };
}

export default DefaultWelcomeServiceFactory;
