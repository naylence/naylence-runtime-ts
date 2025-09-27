import { registerFactory } from 'naylence-factory';
import type { EnvelopeSigner } from './envelope-signer.js';
import {
  ENVELOPE_SIGNER_FACTORY_BASE_TYPE,
  EnvelopeSignerFactory,
  type EnvelopeSignerConfig,
} from './envelope-signer.js';
import { EdDSAEnvelopeSigner, type EdDSAEnvelopeSignerOptions } from './eddsa-envelope-signer.js';

export interface EdDSAEnvelopeSignerConfig extends EnvelopeSignerConfig {
  type: 'EdDSAEnvelopeSigner';
}

export class EdDSAEnvelopeSignerFactory extends EnvelopeSignerFactory<EdDSAEnvelopeSignerConfig> {
  public readonly type = 'EdDSAEnvelopeSigner';
  public readonly isDefault = true;

  public async create(
    _config?: EdDSAEnvelopeSignerConfig | Record<string, unknown> | null,
    options?: EdDSAEnvelopeSignerOptions | null
  ): Promise<EnvelopeSigner> {
    const resolved: EdDSAEnvelopeSignerOptions = {
      cryptoProvider: options?.cryptoProvider ?? null,
      signingConfig: options?.signingConfig ?? null,
    };

    if (options?.privateKeyPem !== undefined) {
      resolved.privateKeyPem = options.privateKeyPem;
    }

    if (options?.keyId !== undefined) {
      resolved.keyId = options.keyId;
    }

    return new EdDSAEnvelopeSigner(resolved);
  }
}

registerFactory(
  ENVELOPE_SIGNER_FACTORY_BASE_TYPE,
  'EdDSAEnvelopeSigner',
  EdDSAEnvelopeSignerFactory,
  { isDefault: true }
);
