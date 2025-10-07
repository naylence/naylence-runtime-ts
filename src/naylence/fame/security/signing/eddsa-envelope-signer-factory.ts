import { safeImport } from '../../util/lazy-import.js';
import type { EnvelopeSigner } from './envelope-signer.js';
import {
  ENVELOPE_SIGNER_FACTORY_BASE_TYPE,
  EnvelopeSignerFactory,
  type EnvelopeSignerConfig,
} from './envelope-signer.js';
import type { EdDSAEnvelopeSignerOptions } from './eddsa-envelope-signer.js';

type EdDSAEnvelopeSignerModule = typeof import('./eddsa-envelope-signer.js');

let eddsaEnvelopeSignerModulePromise: Promise<EdDSAEnvelopeSignerModule> | null =
  null;
async function getEdDSAEnvelopeSignerModule(): Promise<EdDSAEnvelopeSignerModule> {
  if (!eddsaEnvelopeSignerModulePromise) {
    eddsaEnvelopeSignerModulePromise = safeImport(
      () => import('./eddsa-envelope-signer.js'),
      {
        dependencyName: 'EdDSAEnvelopeSigner',
        helpMessage:
          "Missing optional signing dependencies. Install '@noble/ed25519' and '@noble/hashes' to enable EdDSA signing.",
      }
    );
  }

  return eddsaEnvelopeSignerModulePromise;
}

export interface EdDSAEnvelopeSignerConfig extends EnvelopeSignerConfig {
  type: 'EdDSAEnvelopeSigner';
}

export const FACTORY_META = {
  base: ENVELOPE_SIGNER_FACTORY_BASE_TYPE,
  key: 'EdDSAEnvelopeSigner',
} as const;

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

    const { EdDSAEnvelopeSigner } = await getEdDSAEnvelopeSignerModule();

    return new EdDSAEnvelopeSigner(resolved);
  }
}

export default EdDSAEnvelopeSignerFactory;
