import type { SecuritySettings } from '@naylence/core';
import * as factoryModule from '@naylence/factory';

import type { CertificateManager } from '../cert/certificate-manager.js';
import {
  CertificateManagerFactory,
  CERTIFICATE_MANAGER_FACTORY_BASE_TYPE,
  type CreateCertificateManagerOptions,
} from '../cert/certificate-manager-factory.js';
import { SigningConfig } from '../signing/signing-config.js';

describe('CertificateManagerFactory.createCertificateManager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes snake_case config keys before delegating to the factory', async () => {
    const mockManager = {
      symbol: 'cert-manager',
    } as unknown as CertificateManager;
    const createDefaultResourceSpy = jest
      .spyOn(factoryModule, 'createDefaultResource')
      .mockResolvedValue(mockManager);

    const config = {
      type: 'CustomCertificateManager',
      security_settings: {
        allowSelfSigned: true,
      } as unknown as SecuritySettings,
      signing_config: new SigningConfig(),
    };

    const result =
      await CertificateManagerFactory.createCertificateManager(config);

    expect(result).toBe(mockManager);
    expect(createDefaultResourceSpy).toHaveBeenCalledWith(
      CERTIFICATE_MANAGER_FACTORY_BASE_TYPE,
      {
        type: 'CustomCertificateManager',
        securitySettings: config.security_settings,
        signing: config.signing_config,
      },
      { factoryArgs: [null, null] }
    );
  });

  it('normalizes snake_case options and builds factory arguments', async () => {
    const mockManager = {
      symbol: 'cert-manager-options',
    } as unknown as CertificateManager;
    const createDefaultResourceSpy = jest
      .spyOn(factoryModule, 'createDefaultResource')
      .mockResolvedValue(mockManager);

    const securitySettings = {
      tls: { allowSelfSigned: true },
    } as unknown as SecuritySettings;
    const signingConfig = new SigningConfig();

    const result = await CertificateManagerFactory.createCertificateManager(
      null,
      {
        region: 'us-test-1',
        security_settings: securitySettings,
        signing_config: signingConfig,
        factory_args: ['extra'],
      } as unknown as CreateCertificateManagerOptions
    );

    expect(result).toBe(mockManager);
    expect(createDefaultResourceSpy).toHaveBeenCalledWith(
      CERTIFICATE_MANAGER_FACTORY_BASE_TYPE,
      null,
      {
        region: 'us-test-1',
        factoryArgs: [securitySettings, signingConfig, 'extra'],
      }
    );
  });
});
