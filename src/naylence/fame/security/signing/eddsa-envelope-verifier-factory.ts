import { safeImport } from "../../util/lazy-import.js";
import type { EnvelopeVerifier } from "./envelope-verifier.js";
import {
  ENVELOPE_VERIFIER_FACTORY_BASE_TYPE,
  EnvelopeVerifierFactory,
  type EnvelopeVerifierConfig,
} from "./envelope-verifier.js";
import type { KeyProvider } from "../keys/key-provider.js";
import type { SigningConfig } from "./signing-config.js";
import type { EdDSAEnvelopeVerifierOptions } from "./eddsa-envelope-verifier.js";

type EdDSAEnvelopeVerifierModule = typeof import("./eddsa-envelope-verifier.js");

let eddsaEnvelopeVerifierModulePromise: Promise<EdDSAEnvelopeVerifierModule> | null = null;
async function getEdDSAEnvelopeVerifierModule(): Promise<EdDSAEnvelopeVerifierModule> {
  if (!eddsaEnvelopeVerifierModulePromise) {
    eddsaEnvelopeVerifierModulePromise = safeImport(
      () => import("./eddsa-envelope-verifier.js"),
      {
        dependencyName: "EdDSAEnvelopeVerifier",
        helpMessage:
          "Missing optional verification dependencies. Install '@noble/ed25519' and '@noble/hashes' to enable EdDSA verification.",
      }
    );
  }

  return eddsaEnvelopeVerifierModulePromise;
}

export interface EdDSAEnvelopeVerifierConfig extends EnvelopeVerifierConfig {
  type: "EdDSAEnvelopeVerifier";
}

export const FACTORY_META = {
  base: ENVELOPE_VERIFIER_FACTORY_BASE_TYPE,
  key: "EdDSAEnvelopeVerifier",
} as const;

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

    const { EdDSAEnvelopeVerifier } = await getEdDSAEnvelopeVerifierModule();

    return new EdDSAEnvelopeVerifier(provider, resolved);
  }
}

export default EdDSAEnvelopeVerifierFactory;

