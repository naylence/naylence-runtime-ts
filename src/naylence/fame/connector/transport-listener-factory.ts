import type { CreateResourceOptions } from '@naylence/factory';
import {
  AbstractResourceFactory,
  createDefaultResource,
  createResource,
} from '@naylence/factory';

import type { TransportListener } from './transport-listener.js';
import type { TransportListenerConfig } from './transport-listener-config.js';
import type { NodeEventListener } from '../node/node-event-listener.js';

export const TRANSPORT_LISTENER_FACTORY_BASE_TYPE = 'TransportListenerFactory';

export abstract class TransportListenerFactory<
  C extends TransportListenerConfig = TransportListenerConfig,
> extends AbstractResourceFactory<TransportListener, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener>;

  public static async createTransportListener(
    config:
      | TransportListenerConfig
      | Record<string, unknown>
      | null
      | undefined,
    eventListeners: NodeEventListener[],
    options: CreateResourceOptions = {}
  ): Promise<TransportListener | null> {
    const configRecord = (config ?? null) as Record<string, unknown> | null;
    const effectiveListeners = Array.isArray(eventListeners)
      ? eventListeners
      : [];
    const resolvedFactoryArgs = [
      effectiveListeners,
      ...(options.factoryArgs ?? []),
    ];
    const resolvedOptions: CreateResourceOptions = {
      ...options,
      factoryArgs: resolvedFactoryArgs,
    };

    const listener = configRecord
      ? await createResource<TransportListener>(
          TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
          configRecord,
          resolvedOptions
        )
      : await createDefaultResource<TransportListener>(
          TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
          null,
          resolvedOptions
        );

    return listener ?? null;
  }

  public static async createTransportListeners(
    configs: Array<TransportListenerConfig | Record<string, unknown> | null>,
    eventListeners: NodeEventListener[],
    options: CreateResourceOptions = {}
  ): Promise<TransportListener[]> {
    const listeners: TransportListener[] = [];

    for (const config of configs) {
      const listener = await this.createTransportListener(
        config ?? undefined,
        eventListeners,
        options
      );
      if (listener) {
        listeners.push(listener);
      }
    }

    return listeners;
  }
}
