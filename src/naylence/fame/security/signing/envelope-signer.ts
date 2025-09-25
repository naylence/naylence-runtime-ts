import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import { AbstractResourceFactory, createDefaultResource, createResource } from 'naylence-factory';
import type { FameEnvelope } from 'naylence-core';

export interface EnvelopeSigner {
  signEnvelope(envelope: FameEnvelope, options: { physicalPath: string }): FameEnvelope;
}

export interface EnvelopeSignerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export const ENVELOPE_SIGNER_FACTORY_BASE_TYPE = 'EnvelopeSignerFactory';

export abstract class EnvelopeSignerFactory<
  C extends EnvelopeSignerConfig = EnvelopeSignerConfig
> extends AbstractResourceFactory<EnvelopeSigner, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<EnvelopeSigner>;

  public static async createEnvelopeSigner<C extends EnvelopeSignerConfig = EnvelopeSignerConfig>(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<EnvelopeSigner> {
    if (config) {
      const instance = await createResource<EnvelopeSigner>(
        ENVELOPE_SIGNER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!instance) {
        throw new Error('Failed to create envelope signer from configuration');
      }

      return instance;
    }

    const instance = await createDefaultResource<EnvelopeSigner>(
      ENVELOPE_SIGNER_FACTORY_BASE_TYPE,
      null,
      options
    );

    if (!instance) {
      throw new Error('Failed to create default envelope signer');
    }

    return instance;
  }
}
