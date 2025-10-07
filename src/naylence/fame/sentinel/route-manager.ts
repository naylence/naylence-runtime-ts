import {
  AuthorizationContextSchema,
  DeliveryOriginType,
  FameResponseType,
  type FameConnector,
  type FameEnvelope,
  type FameMessageResponse,
} from 'naylence-core';

import {
  ConnectorFactory,
  createResource,
} from '../connector/connector-factory.js';
import type { ConnectorConfig } from '../connector/connector-config.js';
import { FameTransportClose } from '../errors/errors.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { delay } from '../util/task-utils.js';
import { getLogger } from '../util/logging.js';
import { AsyncLock } from '../util/lock.js';
import type {
  FameAuthorizedDeliveryContext,
  FameNodeAuthorizationContext,
} from '../node/node-context.js';
import type { AddressRouteInfo } from './key-frame-handler.js';
import type {
  RouteStore,
  RouteEntry,
  NormalizedRouteEntry,
} from './store/route-store.js';
import {
  getDefaultRouteStore,
  normalizeRouteEntry,
} from './store/route-store.js';

const logger = getLogger('route-manager');

const DEFAULT_CONNECTOR_CLEANUP_DELAY_MS = 200;

export interface PendingRouteEntry {
  connector: FameConnector;
  attached: {
    set(): void;
    wait?(options?: { signal?: AbortSignal }): Promise<void> | void;
  };
  buffer: FameEnvelope[];
  cancelAttachTimeout?: () => void;
}

interface RouteManagerOptions {
  deliver: (
    envelope: FameEnvelope,
    context: FameAuthorizedDeliveryContext
  ) => Promise<void>;
  routeStore?: RouteStore;
  getId?: () => string;
  cleanupDelayMs?: number;
}

export class RouteManager extends TaskSpawner {
  public readonly downstreamRoutes = new Map<string, FameConnector>();
  public readonly _downstream_addresses_routes = new Map<
    string,
    AddressRouteInfo
  >();
  public readonly _downstream_addresses_legacy = new Map<
    string,
    AddressRouteInfo
  >();
  public readonly _peer_routes = new Map<string, FameConnector>();
  public readonly _peer_addresses_routes = new Map<string, string>();
  public readonly _pending_route_metadata = new Map<string, ConnectorConfig>();
  public readonly _pools = new Map<string, Set<string>>();

  public readonly _downstream_route_store: RouteStore;
  public readonly _peer_route_store: RouteStore;

  private readonly deliver: RouteManagerOptions['deliver'];
  private readonly getId: () => string;
  private readonly _routesLock = new AsyncLock();
  private readonly stopController = new AbortController();
  private readonly cleanupDelayMs: number;
  private readonly pendingCleanupControllers = new Map<
    string,
    AbortController
  >();

  private readonly flowRoutes = new Map<string, FameConnector>();
  public readonly _pending_routes = new Map<string, PendingRouteEntry>();

  constructor(options: RouteManagerOptions) {
    super();
    this.deliver = options.deliver;
    this._downstream_route_store = options.routeStore ?? getDefaultRouteStore();
    this._peer_route_store = options.routeStore ?? getDefaultRouteStore();
    this.getId = options.getId ?? (() => '');
    const configuredDelay = options.cleanupDelayMs;
    this.cleanupDelayMs = Number.isFinite(configuredDelay ?? NaN)
      ? Math.max(0, Number(configuredDelay))
      : DEFAULT_CONNECTOR_CLEANUP_DELAY_MS;
  }

  public get routesLock(): AsyncLock {
    return this._routesLock;
  }

  public async start(): Promise<void> {
    await this.restoreRoutes();
    this.spawn(() => this.janitorLoop(), {
      name: `route-janitor-${this.getId()}`,
    });
  }

  public async stop(): Promise<void> {
    this.stopController.abort();

    await this._routesLock.runExclusive(async () => {
      for (const connector of this.downstreamRoutes.values()) {
        await this.safeStop(connector);
      }
      for (const connector of this._peer_routes.values()) {
        await this.safeStop(connector);
      }
      this.downstreamRoutes.clear();
      this._downstream_addresses_routes.clear();
      this._downstream_addresses_legacy.clear();
      this._peer_routes.clear();
      this._peer_addresses_routes.clear();
    });

    for (const entry of this._pending_routes.values()) {
      try {
        entry.cancelAttachTimeout?.();
        await this.safeStop(entry.connector);
      } catch (error) {
        logger.debug('pending_route_stop_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this._pending_routes.clear();
    this._pending_route_metadata.clear();

    await this.shutdownTasks({ cancelHanging: true });
  }

  public getFlowRoute(flowId: string): FameConnector | undefined {
    return this.flowRoutes.get(flowId);
  }

  public trackFlowRoute(flowId: string, connector: FameConnector): void {
    this.flowRoutes.set(flowId, connector);
  }

  public clearFlowRoute(flowId: string): void {
    this.flowRoutes.delete(flowId);
  }

  public async registerDownstreamRoute(
    segment: string,
    route: FameConnector
  ): Promise<void> {
    await this._routesLock.runExclusive(async () => {
      this.cancelPendingCleanup(segment);
      this.downstreamRoutes.set(segment, route);
    });
    logger.debug('registered_downstream_route', { route: segment });
  }

  public async unregisterDownstreamRoute(segment: string): Promise<void> {
    await this.removeDownstreamRoute(segment);
  }

  public async registerPeerRoute(
    segment: string,
    route: FameConnector
  ): Promise<void> {
    await this._routesLock.runExclusive(async () => {
      this.cancelPendingCleanup(segment);
      this._peer_routes.set(segment, route);
    });
    logger.debug('registered_peer_route', { route: segment });
  }

  public async unregisterPeerRoute(segment: string): Promise<void> {
    await this.removePeerRoute(segment);
  }

  public async restoreRoutes(): Promise<void> {
    const entries = await this._downstream_route_store.list();
    const now = new Date();

    const entryTuples = Object.entries(entries) as Array<[string, RouteEntry]>;
    await Promise.all(
      entryTuples.map(async ([segment, entry]) => {
        const normalized = this.normalizeEntry(entry);
        if (!normalized.connectorConfig) {
          logger.warning('route_restore_missing_config', { segment });
          return;
        }

        if (normalized.attachExpiresAt && normalized.attachExpiresAt < now) {
          logger.debug('skipping_expired_route', { segment });
          return;
        }

        const authorization = this.parseAuthorization(normalized.metadata);
        const connectorConfig = normalized.connectorConfig;

        let backoff = 2000;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const connector = await this.createConnector(connectorConfig);
            const deliveryContext = this.buildAuthorizedContext({
              segment,
              connector,
              authorization,
            });

            await connector.start(
              async (
                envelope: FameEnvelope
              ): Promise<FameMessageResponse | null> => {
                await this.deliver(envelope, deliveryContext);
                return null;
              }
            );

            await this._routesLock.runExclusive(async () => {
              this.downstreamRoutes.set(segment, connector);
            });

            if (normalized.attachExpiresAt) {
              const delayMs =
                normalized.attachExpiresAt.getTime() - now.getTime();
              if (delayMs > 0) {
                this.spawn(() => this.expireRouteLater(segment, delayMs), {
                  name: `expire-restore-${this.getId()}`,
                });
              }
            }
            break;
          } catch (error) {
            if (this.isTransientError(error)) {
              logger.warning('transient_restore_failure', {
                segment,
                attempt,
                error: error instanceof Error ? error.message : String(error),
              });
              await delay(backoff, this.stopController.signal).catch(
                () => undefined
              );
              backoff *= 2;
              continue;
            }

            logger.error('failed_to_restore_route', {
              segment,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }
        }
      })
    );
  }

  private async expireRouteLater(
    segment: string,
    delayMs: number
  ): Promise<void> {
    if (delayMs > 0) {
      try {
        await delay(delayMs, this.stopController.signal);
      } catch {
        return;
      }
    }

    let connector: FameConnector | undefined;
    await this._routesLock.runExclusive(async () => {
      connector = this.downstreamRoutes.get(segment);
      this.downstreamRoutes.delete(segment);
    });

    if (connector) {
      await this.safeStop(connector);
    }

    await this._downstream_route_store
      .delete(segment)
      .catch((error: unknown) => {
        logger.warning('route_expiration_delete_failed', {
          segment,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    this.purgeRouteReferences(segment);
    logger.debug('expired_route', { route: segment });
  }

  private async removeDownstreamRoute(
    segment: string,
    options?: { stop?: boolean; delayMs?: number }
  ): Promise<void> {
    await this.removeRoute(
      segment,
      this.downstreamRoutes,
      this._downstream_route_store,
      options
    );
  }

  private async removePeerRoute(
    segment: string,
    options?: { stop?: boolean; delayMs?: number }
  ): Promise<void> {
    await this.removeRoute(
      segment,
      this._peer_routes,
      this._peer_route_store,
      options
    );
  }

  private async removeRoute(
    segment: string,
    routes: Map<string, FameConnector>,
    store: RouteStore,
    options?: { stop?: boolean; delayMs?: number }
  ): Promise<void> {
    let connector: FameConnector | undefined;
    await this._routesLock.runExclusive(async () => {
      connector = routes.get(segment);
      routes.delete(segment);
    });

    const stop = options?.stop ?? true;
    const delayMs = options?.delayMs ?? this.cleanupDelayMs;

    if (connector && stop) {
      await this.cleanupConnector(segment, connector, delayMs);
    }

    this.purgeRouteReferences(segment);

    await store.delete(segment).catch((error: unknown) => {
      logger.warning('route_delete_failed', {
        segment,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.debug('removed_route', { segment });
  }

  private purgeRouteReferences(segment: string): void {
    for (const [address, info] of this._downstream_addresses_routes.entries()) {
      if (info.segment === segment) {
        this._downstream_addresses_routes.delete(address);
      }
    }

    for (const [address, info] of this._downstream_addresses_legacy.entries()) {
      if (info.segment === segment) {
        this._downstream_addresses_legacy.delete(address);
      }
    }

    for (const [
      address,
      mappedSegment,
    ] of this._peer_addresses_routes.entries()) {
      if (mappedSegment === segment) {
        this._peer_addresses_routes.delete(address);
      }
    }

    for (const pool of this._pools.values()) {
      pool.delete(segment);
    }
  }

  private cancelPendingCleanup(segment: string): void {
    const controller = this.pendingCleanupControllers.get(segment);
    if (!controller) {
      return;
    }
    controller.abort();
    this.pendingCleanupControllers.delete(segment);
  }

  private async cleanupConnector(
    segment: string,
    connector: FameConnector,
    delayMs: number
  ): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      await this.safeStop(connector);
      return;
    }

    this.cancelPendingCleanup(segment);
    const controller = new AbortController();
    this.pendingCleanupControllers.set(segment, controller);

    this.spawn(
      async (taskSignal) => {
        const combined = new AbortController();
        const abortHandler = () => combined.abort();

        controller.signal.addEventListener('abort', abortHandler);
        if (taskSignal) {
          if (taskSignal.aborted) {
            combined.abort();
          } else {
            taskSignal.addEventListener('abort', abortHandler);
          }
        }

        try {
          await delay(delayMs, combined.signal);
        } catch (error) {
          if (combined.signal.aborted) {
            logger.debug('connector_cleanup_cancelled', { segment });
          } else {
            logger.debug('connector_cleanup_delay_failed', {
              segment,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        } finally {
          controller.signal.removeEventListener('abort', abortHandler);
          taskSignal?.removeEventListener('abort', abortHandler);
          if (this.pendingCleanupControllers.get(segment) === controller) {
            this.pendingCleanupControllers.delete(segment);
          }
        }

        await this.safeStop(connector);
      },
      { name: `route-cleanup-${segment}-${this.getId()}` }
    );
  }

  private async safeStop(connector: FameConnector): Promise<void> {
    try {
      await connector.stop();
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('connector_stop_ignored', { error: error.message });
      }
    }

    for (const [flowId, peer] of this.flowRoutes.entries()) {
      if (peer === connector) {
        this.flowRoutes.delete(flowId);
      }
    }
  }

  private async janitorLoop(): Promise<void> {
    const signal = this.stopController.signal;

    try {
      while (!signal.aborted) {
        const now = new Date();

        await this.scanStoreForExpirations(
          this._downstream_route_store,
          now,
          'downstream'
        );
        await this.scanStoreForExpirations(this._peer_route_store, now, 'peer');

        try {
          await delay(1000, signal);
        } catch {
          break;
        }
      }
    } catch (error) {
      logger.error('janitor_loop_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      logger.debug('janitor_loop_exited');
    }
  }

  private async scanStoreForExpirations(
    store: RouteStore,
    now: Date,
    kind: 'downstream' | 'peer'
  ): Promise<void> {
    const entries = await store.list();

    const entryTuples = Object.entries(entries) as Array<[string, RouteEntry]>;
    await Promise.all(
      entryTuples.map(async ([segment, entry]) => {
        const normalized = this.normalizeEntry(entry);
        if (!normalized.attachExpiresAt || normalized.attachExpiresAt >= now) {
          return;
        }

        await this._routesLock.runExclusive(async () => {
          const map =
            kind === 'downstream' ? this.downstreamRoutes : this._peer_routes;
          const connector = map.get(segment);
          if (connector) {
            map.delete(segment);
            await this.safeStop(connector);
          }
        });

        await store.delete(segment).catch((error: unknown) => {
          logger.warning('route_auto_expire_delete_failed', {
            segment,
            error: error instanceof Error ? error.message : String(error),
          });
        });

        this.purgeRouteReferences(segment);
        logger.debug('auto_expired_route', { segment });
      })
    );
  }

  private parseAuthorization(
    metadata: Record<string, unknown> | null
  ): FameNodeAuthorizationContext | null {
    if (!metadata) {
      return null;
    }

    try {
      const base = AuthorizationContextSchema.parse(metadata);
      const record = metadata;
      return {
        ...base,
        sub: pickString(record.sub ?? record['sub']),
        aud: pickString(record.aud ?? record['aud']),
        assignedPath: pickString(
          record.assignedPath ?? record['assigned_path']
        ),
        acceptedCapabilities: pickStringArray(
          record.acceptedCapabilities ?? record['accepted_capabilities']
        ),
        acceptedLogicals: pickStringArray(
          record.acceptedLogicals ?? record['accepted_logicals']
        ),
        instanceId: pickString(record.instanceId ?? record['instance_id']),
        scopes: pickStringArray(record.scopes),
        attachExpiresAt: pickDate(
          record.attachExpiresAt ?? record['attach_expires_at']
        ),
      } satisfies FameNodeAuthorizationContext;
    } catch (error) {
      logger.error('corrupt_route_metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildAuthorizedContext(options: {
    segment: string;
    connector: FameConnector;
    authorization: FameNodeAuthorizationContext | null;
  }): FameAuthorizedDeliveryContext {
    const security = options.authorization
      ? { authorization: options.authorization }
      : undefined;

    return {
      fromSystemId: options.segment,
      fromConnector: options.connector,
      originType: DeliveryOriginType.DOWNSTREAM,
      expectedResponseType: FameResponseType.NONE,
      security,
    };
  }

  private normalizeEntry(entry: RouteEntry): NormalizedRouteEntry {
    return normalizeRouteEntry(entry);
  }

  private async createConnector(
    config: ConnectorConfig
  ): Promise<FameConnector> {
    if (
      ConnectorFactory &&
      typeof ConnectorFactory.createConnector === 'function'
    ) {
      return await ConnectorFactory.createConnector(config);
    }
    return await createResource(config);
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof FameTransportClose) {
      return true;
    }
    if (error instanceof Error) {
      const message = error.message ?? '';
      return (
        message.includes('Timeout') ||
        message.includes('ECONN') ||
        message.includes('temporary')
      );
    }
    return false;
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === 'string'
  );
  return strings.length ? strings : undefined;
}

function pickDate(value: unknown): Date | undefined {
  if (!value && value !== 0) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
