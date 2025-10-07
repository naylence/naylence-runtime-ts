import type { CreateResourceOptions, ResourceConfig } from 'naylence-factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from 'naylence-factory';
import type { NodeHelloFrame } from 'naylence-core';

import type { PlacementDecision } from '../placement/node-placement-strategy.js';
import type { ConnectionGrant } from '../grants/connection-grant.js';

export const TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE =
  'TransportProvisionerFactory' as const;

export interface TransportProvisionResult {
  connectionGrant: ConnectionGrant | Record<string, unknown>;
  cleanupHandle?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface TransportProvisioner {
  provision(
    decision: PlacementDecision,
    hello: NodeHelloFrame,
    fullMetadata: Record<string, unknown>,
    attachToken?: string | null
  ): Promise<TransportProvisionResult>;

  deprovision(cleanupHandle?: string | null): Promise<void>;
}

export interface TransportProvisionerConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}

export abstract class TransportProvisionerFactory<
  C extends TransportProvisionerConfig = TransportProvisionerConfig,
> extends AbstractResourceFactory<TransportProvisioner, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportProvisioner>;

  public static async createTransportProvisioner<
    C extends TransportProvisionerConfig = TransportProvisionerConfig,
  >(
    config?: C | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<TransportProvisioner> {
    if (config) {
      const provisioner = await createResource<TransportProvisioner>(
        TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE,
        config,
        options
      );

      if (!provisioner) {
        throw new Error(
          'Failed to create transport provisioner from configuration'
        );
      }

      return provisioner;
    }

    let provisioner: TransportProvisioner | null = null;
    try {
      provisioner = await createDefaultResource<TransportProvisioner>(
        TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE,
        null,
        options
      );
    } catch (error) {
      const message =
        'Failed to create default transport provisioner' +
        (error instanceof Error && error.message ? `: ${error.message}` : '');
      throw new Error(message);
    }

    if (!provisioner) {
      throw new Error('Failed to create default transport provisioner');
    }

    return provisioner;
  }
}
