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
  signing?: SigningConfig | null;
  [key: string]: unknown;
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
    const {
      securitySettings = null,
      signing = null,
      factoryArgs = [],
      ...rest
    } = opts;
    const args = [securitySettings, signing, ...factoryArgs];

    return await createDefaultResource<CertificateManager>(
      CERTIFICATE_MANAGER_FACTORY_BASE_TYPE,
      cfg ? { ...(cfg as Record<string, unknown>) } : null,
      { ...rest, factoryArgs: args }
    );
  }
}
