import type { SecuritySettings } from '@naylence/core';
import type { CreateResourceOptions, ResourceConfig } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
} from '@naylence/factory';

import type { SigningConfig } from '../signing/signing-config.js';
import type { CertificateManager } from './certificate-manager.js';

export const CERTIFICATE_MANAGER_FACTORY_BASE_TYPE =
  'CertificateManagerFactory';

export interface CertificateManagerConfig extends ResourceConfig {
  type: string;
  security_settings?: SecuritySettings | null;
  signing_config?: SigningConfig | null;
  signing?: SigningConfig | null;
  [key: string]: unknown;
}

type CertificateManagerConfigLike =
  | CertificateManagerConfig
  | (Record<string, unknown> & {
      security_settings?: SecuritySettings | null;
      signing_config?: SigningConfig | null;
    });

function normalizeCertificateManagerConfig(
  cfg: CertificateManagerConfigLike
): Record<string, unknown> {
  const normalized = { ...(cfg as Record<string, unknown>) };

  if ('security_settings' in normalized) {
    if (normalized.securitySettings === undefined) {
      normalized.securitySettings =
        normalized.security_settings as SecuritySettings | null;
    }
    delete normalized.security_settings;
  }

  if ('signing_config' in normalized) {
    if (normalized.signing === undefined) {
      normalized.signing = normalized.signing_config as SigningConfig | null;
    }
    delete normalized.signing_config;
  }

  return normalized;
}

type CreateCertificateManagerOptionsLike = CreateCertificateManagerOptions &
  Record<string, unknown> & {
    security_settings?: SecuritySettings | null;
    signing_config?: SigningConfig | null;
    factory_args?: unknown[];
  };

function normalizeCreateCertificateManagerOptions(
  options: CreateCertificateManagerOptionsLike
): {
  rest: Record<string, unknown>;
  securitySettings: SecuritySettings | null;
  signing: SigningConfig | null;
  factoryArgs: unknown[];
} {
  const {
    securitySettings: camelSecuritySettings,
    security_settings: snakeSecuritySettings,
    signing: camelSigning,
    signing_config: snakeSigning,
    factoryArgs: camelFactoryArgs,
    factory_args: snakeFactoryArgs,
    ...rest
  } = options;

  const securitySettings = (camelSecuritySettings ??
    snakeSecuritySettings ??
    null) as SecuritySettings | null;
  const signing = (camelSigning ??
    snakeSigning ??
    null) as SigningConfig | null;
  const rawFactoryArgs = camelFactoryArgs ?? snakeFactoryArgs;
  let factoryArgs: unknown[];
  if (rawFactoryArgs === undefined || rawFactoryArgs === null) {
    factoryArgs = [];
  } else if (Array.isArray(rawFactoryArgs)) {
    factoryArgs = rawFactoryArgs;
  } else {
    factoryArgs = [rawFactoryArgs];
  }

  return {
    rest,
    securitySettings,
    signing,
    factoryArgs,
  };
}

export interface CreateCertificateManagerOptions
  extends Omit<CreateResourceOptions, 'factoryArgs'> {
  securitySettings?: SecuritySettings | null;
  signing?: SigningConfig | null;
  factoryArgs?: unknown[];
}

export abstract class CertificateManagerFactory<
  C extends CertificateManagerConfig = CertificateManagerConfig,
> extends AbstractResourceFactory<CertificateManager, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    securitySettings?: SecuritySettings | null,
    signing?: SigningConfig | null,
    ...factoryArgs: unknown[]
  ): Promise<CertificateManager>;

  public static async createCertificateManager<
    C extends CertificateManagerConfig = CertificateManagerConfig,
  >(
    cfg?: C | Record<string, unknown> | null,
    opts: CreateCertificateManagerOptions = {}
  ): Promise<CertificateManager | null> {
    const { rest, securitySettings, signing, factoryArgs } =
      normalizeCreateCertificateManagerOptions(
        opts as CreateCertificateManagerOptionsLike
      );
    const args = [securitySettings, signing, ...factoryArgs];

    const normalizedConfig = cfg
      ? normalizeCertificateManagerConfig(cfg as CertificateManagerConfigLike)
      : null;

    return await createDefaultResource<CertificateManager>(
      CERTIFICATE_MANAGER_FACTORY_BASE_TYPE,
      normalizedConfig,
      { ...rest, factoryArgs: args }
    );
  }
}
