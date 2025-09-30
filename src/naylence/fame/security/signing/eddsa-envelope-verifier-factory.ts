import { registerFactory } from "naylence-factory";
import type { EnvelopeVerifier } from "./envelope-verifier.js";
import {
  ENVELOPE_VERIFIER_FACTORY_BASE_TYPE,
  EnvelopeVerifierFactory,
  type EnvelopeVerifierConfig,
} from "./envelope-verifier.js";
import type { KeyProvider } from "../keys/key-provider.js";
import type { SigningConfig } from "./signing-config.js";
import {
  EdDSAEnvelopeVerifier,
  type EdDSAEnvelopeVerifierOptions,
} from "./eddsa-envelope-verifier.js";

export interface EdDSAEnvelopeVerifierConfig extends EnvelopeVerifierConfig {
  type: "EdDSAEnvelopeVerifier";
}

export class EdDSAEnvelopeVerifierFactory extends EnvelopeVerifierFactory<EdDSAEnvelopeVerifierConfig> {
  public readonly type = "EdDSAEnvelopeVerifier";
  public readonly isDefault = true;

  public async create(
    _config?: EdDSAEnvelopeVerifierConfig | Record<string, unknown> | null,
    keyProvider?: KeyProvider | null,
    signingConfig?: SigningConfig | null,
    options: EdDSAEnvelopeVerifierOptions = {}
  ): Promise<EnvelopeVerifier> {
    const provider = keyProvider ?? null;
    if (!provider) {
      throw new Error("EdDSAEnvelopeVerifierFactory requires a key provider");
    }

    const resolved: EdDSAEnvelopeVerifierOptions = {
      signingConfig: options.signingConfig ?? signingConfig ?? null,
    };

    return new EdDSAEnvelopeVerifier(provider, resolved);
  }
}

registerFactory(
  ENVELOPE_VERIFIER_FACTORY_BASE_TYPE,
  "EdDSAEnvelopeVerifier",
  EdDSAEnvelopeVerifierFactory,
  { isDefault: true }
);
