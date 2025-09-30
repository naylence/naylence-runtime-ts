import type { CreateResourceOptions, ResourceConfig } from "naylence-factory";
import { AbstractResourceFactory, createDefaultResource, createResource } from "naylence-factory";
import type { FameEnvelope } from "naylence-core";

export interface EnvelopeVerifier {
  verifyEnvelope(
    envelope: FameEnvelope,
    options?: {
      checkPayload?: boolean;
      logical?: string;
    }
  ): Promise<boolean>;
}

export interface EnvelopeVerifierConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export const ENVELOPE_VERIFIER_FACTORY_BASE_TYPE = "EnvelopeVerifierFactory";

export abstract class EnvelopeVerifierFactory<
  C extends EnvelopeVerifierConfig = EnvelopeVerifierConfig,
> extends AbstractResourceFactory<EnvelopeVerifier, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<EnvelopeVerifier>;

  public static async createEnvelopeVerifier<
    C extends EnvelopeVerifierConfig = EnvelopeVerifierConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<EnvelopeVerifier> {
    if (config) {
      const instance = await createResource<EnvelopeVerifier>(
        ENVELOPE_VERIFIER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!instance) {
        throw new Error("Failed to create envelope verifier from configuration");
      }

      return instance;
    }

    const instance = await createDefaultResource<EnvelopeVerifier>(
      ENVELOPE_VERIFIER_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!instance) {
      throw new Error("Failed to create default envelope verifier");
    }

    return instance;
  }
}
