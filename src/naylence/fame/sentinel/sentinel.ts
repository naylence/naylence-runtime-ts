import {
  AddressBindAckFrame,
  AddressBindFrame,
  DeliveryOriginType,
  DeliveryAckFrame,
  FameAddress,
  FameConnector,
  FameDeliveryContext,
  FameEnvelope,
  FameEnvelopeHandler,
  FameMessageResponse,
  FameResponseType,
  FameFabric,
  FlowFlags,
  parseAddress,
  SecurityContext,
  formatAddress,
  generateId,
  localDeliveryContext,
  withFabric,
  type FameConfig,
  // type NodeAttachAckFrame,
} from '@naylence/core';

import { currentTraceId } from '../util/envelope-context.js';
import { FameNode, type FameNodeOptions } from '../node/node.js';
import type {
  FameAuthorizedDeliveryContext,
  FameNodeAuthorizationContext,
} from '../node/node-context.js';
import type {
  OriginConnectorOptions,
  RoutingNodeLike,
} from '../node/routing-node-like.js';
import type { RouteStore } from './store/route-store.js';
import {
  createPersistentRouteStore,
  getDefaultRouteStore,
} from './store/route-store.js';
import {
  RouteManager,
  type PendingRouteEntry,
  type RouteRemovalOptions,
} from './route-manager.js';
import type { RoutingPolicy } from './routing-policy.js';
import { CompositeRoutingPolicy } from './composite-routing-policy.js';
import { CapabilityAwareRoutingPolicy } from './capability-aware-routing-policy.js';
import { HybridPathRoutingPolicy } from './hybrid-path-routing-policy.js';
import { NodeAttachFrameHandler } from './node-attach-frame-handler.js';
import { AddressBindFrameHandler } from './address-bind-frame-handler.js';
import { NodeHeartbeatFrameHandler } from './node-heartbeat-frame-handler.js';
import { CapabilityFrameHandler } from './capability-frame-handler.js';
import { CreditUpdateFrameHandler } from './credit-update-frame-handler.js';
import {
  LogLevel,
  LogLevelNames,
  basicConfig,
  getLogger,
  summarizeEnvelope,
} from '../util/logging.js';
// import { TaskSpawner } from "../util/task-spawner.js";
import { delay } from '../util/task-utils.js';
import { AsyncEvent } from '../util/async-event.js';
import { AsyncLock } from '../util/lock.js';
import type { ConnectorConfig } from '../connector/connector-config.js';
import { createResource } from '../connector/connector-factory.js';
import type { Peer } from './peer.js';
import { UpstreamSessionManager } from '../node/upstream-session-manager.js';
import type { SessionManager } from '../node/session-manager.js';
import type {
  NodeAttachClient,
  AttachInfo,
} from '../node/admission/node-attach-client.js';
import type { AdmissionClient } from '../node/admission/admission-client.js';
import type { ConnectionRetryPolicy } from '../node/connection-retry-policy.js';
import type { AttachmentKeyValidator } from '../security/keys/attachment-key-validator.js';
import type { LoadBalancerStickinessManager } from '../stickiness/load-balancer-stickiness-manager.js';
import type { DefaultDeliveryTracker } from '../delivery/default-delivery-tracker.js';
import {
  Drop,
  emitDeliveryNack,
  RouterState,
  type RoutingAction,
} from './router.js';
import type { AddressRouteInfo } from './key-frame-handler.js';
import type { NodeLike } from '../node/node-like.js';

const logger = getLogger('naylence.fame.sentinel.sentinel');

const ALLOWED_BEFORE_ATTACH = new Set(['NodeAttach']);
const SYSTEM_INBOX = '__sys__';
const RESERVED_UPSTREAM_ADDRESS_NAMES = new Set(['__sys__', '__rpc__']);
const DEFAULT_BINDING_ACK_TIMEOUT_MS = 20_000;
const DEFAULT_ATTACH_TIMEOUT_SEC = 5;
const DEFAULT_CONNECTOR_CLEANUP_DELAY_MS = 200;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function computePhysicalSegments(path: string): string[] {
  return path.replace(/^\/+/u, '').split('/').filter(Boolean);
}

export interface SentinelOptions extends FameNodeOptions {
  routeStore?: RouteStore | null;
  routingPolicy?: RoutingPolicy | null;
  attachTimeoutSec?: number;
  maxAttachTtlSec?: number | null;
  bindingAckTimeoutMs?: number;
  peers?: Peer[] | null;
  attachmentKeyValidator?: AttachmentKeyValidator | null;
  stickinessManager?: LoadBalancerStickinessManager | null;
  attachClient?: NodeAttachClient | null;
  cleanupDelayMs?: number;
  rebindOnAttach?: boolean;
  [key: string]: unknown;
}

export interface SentinelServeOptions {
  logLevel?: LogLevel | keyof typeof LogLevelNames | string | number | null;
  rootConfig?: Record<string, unknown> | FameConfig;
  config?: Record<string, unknown> | null;
  node?: NodeLike | null;
  fabric?: FameFabric | null;
  signals?: NodeJS.Signals[];
  signal?: AbortSignal;
  [key: string]: unknown;
}

type SentinelInitOptions =
  | SentinelOptions
  | (SentinelOptions & Record<string, unknown>)
  | Record<string, unknown>;

function normalizeSentinelOptions(
  rawOptions: SentinelInitOptions | null | undefined
): SentinelOptions {
  const normalized: Record<string, unknown> = {
    ...((rawOptions ?? {}) as Record<string, unknown>),
  };

  const assignAlias = (targetKey: string, aliasKeys: readonly string[]) => {
    if (normalized[targetKey] === undefined) {
      for (const alias of aliasKeys) {
        if (alias in normalized) {
          normalized[targetKey] = normalized[alias];
          break;
        }
      }
    }

    for (const alias of aliasKeys) {
      if (alias in normalized) {
        delete normalized[alias];
      }
    }
  };

  assignAlias('routeStore', ['route_store']);
  assignAlias('routingPolicy', ['routing_policy']);
  assignAlias('attachTimeoutSec', ['attach_timeout_sec']);
  assignAlias('maxAttachTtlSec', ['max_attach_ttl_sec']);
  assignAlias('bindingAckTimeoutMs', ['binding_ack_timeout_ms']);
  assignAlias('attachmentKeyValidator', ['attachment_key_validator']);
  assignAlias('stickinessManager', ['stickiness_manager']);
  assignAlias('requestedLogicals', ['requested_logicals']);
  assignAlias('attachClient', ['attach_client']);
  assignAlias('cleanupDelayMs', ['cleanup_delay_ms']);
  assignAlias('rebindOnAttach', ['rebind_on_attach']);

  return normalized as SentinelOptions;
}

function normalizeOriginConnectorOptions(
  rawOptions: OriginConnectorOptions & Record<string, unknown>
): OriginConnectorOptions {
  const normalized: Record<string, unknown> = { ...rawOptions };

  const assignAlias = (targetKey: string, aliasKeys: readonly string[]) => {
    if (normalized[targetKey] === undefined) {
      for (const alias of aliasKeys) {
        if (alias in normalized) {
          normalized[targetKey] = normalized[alias];
          break;
        }
      }
    }

    for (const alias of aliasKeys) {
      if (alias in normalized) {
        delete normalized[alias];
      }
    }
  };

  assignAlias('originType', ['origin_type']);
  assignAlias('systemId', ['system_id']);
  assignAlias('connectorConfig', ['connector_config']);
  assignAlias('authorization', ['authorization_context']);

  return normalized as OriginConnectorOptions;
}

export class Sentinel extends FameNode implements RoutingNodeLike {
  private readonly routeManager: RouteManager;
  private readonly routingPolicy: RoutingPolicy;
  private readonly nodeAttachFrameHandler: NodeAttachFrameHandler;
  private readonly nodeHeartbeatFrameHandler: NodeHeartbeatFrameHandler;
  private readonly addressBindFrameHandler: AddressBindFrameHandler;
  private readonly capabilityFrameHandler: CapabilityFrameHandler;
  private readonly creditUpdateFrameHandler: CreditUpdateFrameHandler;
  private readonly peers: Peer[];
  private readonly attachmentKeyValidator: AttachmentKeyValidator | null;
  private readonly stickinessManager: LoadBalancerStickinessManager | null;
  private readonly ackTimeoutMs: number;
  private readonly maxAttachTtlSec: number | null;
  private readonly requestedLogicals: string[];
  private readonly attachClient: NodeAttachClient | null;
  private readonly connectionRetryPolicy: ConnectionRetryPolicy | null;
  private readonly attachTimeoutMs: number | null;
  private readonly cleanupDelayMs: number;
  private readonly rebindOnAttach: boolean;

  private readonly pendingBinds = new Map<string, Deferred<boolean>>();
  private readonly pendingLock = new AsyncLock();

  private readonly peerSessionManagers = new Map<
    string,
    UpstreamSessionManager
  >();

  private upstreamConnectorRef: FameConnector | null = null;
  private routingEpochValue = generateId();

  private isPreparedToStop = false;

  constructor(options: SentinelInitOptions = {}) {
    const normalizedOptions = normalizeSentinelOptions(options);
    super(normalizedOptions);

    const opts = normalizedOptions;

    let routeStore: RouteStore;
    if (opts.routeStore) {
      routeStore = opts.routeStore;
    } else {
      try {
        routeStore = createPersistentRouteStore(this.storageProvider);
      } catch (error) {
        logger.warning('persistent_route_store_unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
        routeStore = getDefaultRouteStore();
      }
    }
    const cleanupDelayMs = Number.isFinite(opts.cleanupDelayMs ?? NaN)
      ? Math.max(0, Number(opts.cleanupDelayMs))
      : DEFAULT_CONNECTOR_CLEANUP_DELAY_MS;
    this.cleanupDelayMs = cleanupDelayMs;
    const attachTimeoutSec =
      opts.attachTimeoutSec ?? DEFAULT_ATTACH_TIMEOUT_SEC;
    this.attachTimeoutMs =
      typeof attachTimeoutSec === 'number' && Number.isFinite(attachTimeoutSec)
        ? Math.max(0, attachTimeoutSec * 1000)
        : null;

    const rebindOnAttach = opts.rebindOnAttach ?? false;

    this.routeManager = new RouteManager({
      deliver: (
        envelope: FameEnvelope,
        context: FameAuthorizedDeliveryContext
      ) => this.deliver(envelope, context),
      routeStore,
      getId: () => this.id,
      cleanupDelayMs: this.cleanupDelayMs,
    });
    this.rebindOnAttach = rebindOnAttach;

    (this as unknown as { _route_manager?: RouteManager })._route_manager =
      this.routeManager;

    this.routingPolicy =
      opts.routingPolicy ??
      new CompositeRoutingPolicy([
        new CapabilityAwareRoutingPolicy(),
        new HybridPathRoutingPolicy(),
      ]);

    this.attachmentKeyValidator = opts.attachmentKeyValidator ?? null;
    this.stickinessManager = opts.stickinessManager ?? null;
    this.peers = opts.peers ?? [];
    this.ackTimeoutMs =
      opts.bindingAckTimeoutMs ?? DEFAULT_BINDING_ACK_TIMEOUT_MS;
    this.maxAttachTtlSec = opts.maxAttachTtlSec ?? null;
    this.requestedLogicals = opts.requestedLogicals ?? [];
    this.attachClient = opts.attachClient ?? null;
    this.connectionRetryPolicy = opts.connectionRetryPolicy ?? null;

    this.nodeAttachFrameHandler = new NodeAttachFrameHandler({
      routingNode: this,
      routeManager: this.routeManager,
      attachmentKeyValidator: this.attachmentKeyValidator,
      stickinessManager: this.stickinessManager,
      maxTtlSec: this.maxAttachTtlSec,
    });

    this.nodeHeartbeatFrameHandler = new NodeHeartbeatFrameHandler({
      routingNode: this,
    });

    this.addressBindFrameHandler = new AddressBindFrameHandler({
      routingNode: this,
      routeManager: this.routeManager,
      upstreamConnector: () => this.upstreamConnector,
    });

    this.capabilityFrameHandler = new CapabilityFrameHandler({
      routingNode: this,
      routeManager: this.routeManager,
      upstreamConnector: () => this.upstreamConnector,
    });

    this.creditUpdateFrameHandler = new CreditUpdateFrameHandler({
      routeManager: this.routeManager,
    });

    const authorizer = this.securityManager?.authorizer ?? null;
    if (!authorizer) {
      throw new Error(
        'Sentinel nodes require a security manager with an authorizer'
      );
    }

    if (this.rebindOnAttach) {
      this.addEventListener({
        priority: 500,
        onNodeAttachToUpstream: async () => {
          await this.propagateAddressBindingsUpstream();
        },
      });
    }
  }

  get routingEpoch(): string {
    return this.routingEpochValue;
  }

  public bumpRoutingEpoch(): void {
    const previousEpoch = this.routingEpochValue;
    this.routingEpochValue = generateId();
    logger.debug('routing_epoch_bumped', {
      previous_epoch: previousEpoch,
      new_epoch: this.routingEpochValue,
    });
  }

  override get upstreamConnector(): FameConnector | null {
    if (this.upstreamConnectorRef) {
      return this.upstreamConnectorRef;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      FameNode.prototype,
      'upstreamConnector'
    );
    const baseGetter = descriptor?.get;
    return baseGetter ? baseGetter.call(this) : null;
  }

  setUpstreamConnector(connector: FameConnector | null): void {
    this.upstreamConnectorRef = connector;
  }

  async start(): Promise<void> {
    this.isPreparedToStop = false;
    await super.start();
    await this.routeManager.start();
    await this.connectToPeers();
  }

  async prepareToStop(): Promise<void> {
    if (this.isPreparedToStop) {
      return;
    }
    super.prepareToStop();
    this.isPreparedToStop = true;
  }

  async stop(): Promise<void> {
    await this.prepareToStop();
    // await this.lifecycleTasks.shutdownTasks({ cancelHanging: true }).catch(() => undefined);

    for (const manager of this.peerSessionManagers.values()) {
      await manager.stop().catch(() => undefined);
    }
    this.peerSessionManagers.clear();

    await super.stop();
    await this.routeManager.stop();
  }

  override async deliver(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const processedEnvelope = await this.dispatchEnvelopeEvent(
      'onDeliver',
      this,
      envelope,
      context
    );
    if (!processedEnvelope) {
      return;
    }

    const frameType = processedEnvelope.frame?.type ?? null;

    if (
      frameType &&
      [
        'AddressBindAck',
        'AddressUnbindAck',
        'CapabilityAdvertiseAck',
        'CapabilityWithdrawAck',
      ].includes(frameType)
    ) {
      await this.deliveryTracker.onEnvelopeDelivered(
        SYSTEM_INBOX,
        processedEnvelope,
        context
      );
      if (frameType === 'AddressBindAck') {
        const frame = processedEnvelope.frame as
          | AddressBindAckFrame
          | undefined;
        await this.resolvePendingBind(
          processedEnvelope,
          frame?.ok ?? true,
          frame?.reason ?? null
        );
      }
      return;
    }

    if (!context || context.originType !== DeliveryOriginType.LOCAL) {
      if (frameType === 'NodeAttach') {
        await this.nodeAttachFrameHandler.acceptNodeAttach(
          processedEnvelope,
          context
        );
      } else if (frameType === 'AddressBind') {
        await this.addressBindFrameHandler.acceptAddressBind(
          processedEnvelope,
          context
        );
      } else if (frameType === 'AddressUnbind') {
        await this.addressBindFrameHandler.acceptAddressUnbind(
          processedEnvelope,
          context
        );
      } else if (frameType === 'CapabilityAdvertise') {
        await this.capabilityFrameHandler.acceptCapabilityAdvertise(
          processedEnvelope,
          context
        );
      } else if (frameType === 'CapabilityWithdraw') {
        await this.capabilityFrameHandler.acceptCapabilityWithdraw(
          processedEnvelope,
          context
        );
      } else if (frameType === 'CreditUpdate') {
        await this.creditUpdateFrameHandler.acceptCreditUpdate(
          processedEnvelope,
          context
        );
      } else if (frameType === 'NodeHeartbeat') {
        await this.nodeHeartbeatFrameHandler.acceptNodeHeartbeat(
          processedEnvelope,
          context
        );
      }
    }

    const state = this.buildRouterState();
    let action: RoutingAction = await this.routingPolicy.decide(
      processedEnvelope,
      state,
      context
    );

    // Dispatch onRoutingActionSelected hook to allow authorization/replacement
    // The hook must return the action to execute; null/undefined/throw => Drop
    const actionToExecute = await this.dispatchRoutingActionSelected(
      processedEnvelope,
      action,
      state,
      context
    );

    await actionToExecute.execute(processedEnvelope, this, state, context);
  }

  async forwardToRoute(
    nextSegment: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    if (
      this.originMatches(context, nextSegment, DeliveryOriginType.DOWNSTREAM)
    ) {
      logger.debug('downstream_loop_detected', {
        envp_id: envelope.id,
        segment: nextSegment,
      });
    }

    let processed: FameEnvelope | null = null;
    try {
      processed = await this.dispatchEnvelopeEvent(
        'onForwardToRoute',
        this,
        nextSegment,
        envelope,
        context
      );
      if (!processed) {
        return;
      }

      const connector = this.routeManager.downstreamRoutes.get(nextSegment);
      if (!connector) {
        logger.warning('no_route_for_child_segment', { segment: nextSegment });
        await this.emitDeliveryNack(processed, {
          code: 'CHILD_UNREACHABLE',
          context: context ?? null,
        });
        return;
      }

      logger.debug('forwarding_downstream', {
        ...summarizeEnvelope(processed, ''),
        route: nextSegment,
      });

      await connector.send(processed);
      this.trackFlowRoute(processed, connector);
      this.maybeForgetFlow(processed);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.dispatchEnvelopeEvent(
        'onForwardToRouteComplete',
        this,
        nextSegment,
        processed ?? envelope,
        undefined,
        err,
        context
      ).catch(() => undefined);
      throw err;
    }

    await this.dispatchEnvelopeEvent(
      'onForwardToRouteComplete',
      this,
      nextSegment,
      processed ?? envelope,
      undefined,
      undefined,
      context
    ).catch(() => undefined);
  }

  async forwardToPeer(
    peerSegment: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    if (this.originMatches(context, peerSegment, DeliveryOriginType.PEER)) {
      logger.debug('peer_loop_detected', {
        envp_id: envelope.id,
        segment: peerSegment,
      });
    }

    const processed = await this.dispatchEnvelopeEvent(
      'onForwardToPeer',
      this,
      peerSegment,
      envelope,
      context
    );
    if (!processed) {
      return;
    }

    const connector = this.routeManager._peer_routes.get(peerSegment);
    if (!connector) {
      logger.warning('no_route_for_peer_segment', {
        peer_segment: peerSegment,
      });
      await this.emitDeliveryNack(processed, {
        code: 'PEER_UNREACHABLE',
        context: context ?? null,
      });
      return;
    }

    await connector.send(processed);

    await this.dispatchEnvelopeEvent(
      'onForwardToPeerComplete',
      this,
      peerSegment,
      processed,
      undefined,
      undefined,
      context
    ).catch(() => undefined);

    this.trackFlowRoute(processed, connector);
    this.maybeForgetFlow(processed);
  }

  async forwardToPeers(
    envelope: FameEnvelope,
    peers?: string[] | null,
    excludePeers?: string[] | null,
    context?: FameDeliveryContext
  ): Promise<void> {
    const processed = await this.dispatchEnvelopeEvent(
      'onForwardToPeers',
      this,
      envelope,
      peers ?? undefined,
      excludePeers ?? undefined,
      context
    );
    if (!processed) {
      return;
    }

    const availablePeers = new Set(
      peers ?? Array.from(this.routeManager._peer_routes.keys())
    );
    if (excludePeers) {
      for (const peer of excludePeers) {
        availablePeers.delete(peer);
      }
    }

    for (const peerId of availablePeers) {
      const connector = this.routeManager._peer_routes.get(peerId);
      if (!connector) {
        throw new Error(`No route for peer segment '${peerId}'`);
      }

      const forwarded = await this.dispatchEnvelopeEvent(
        'onForwardToPeer',
        this,
        peerId,
        envelope,
        context
      );
      if (!forwarded) {
        continue;
      }

      await connector.send(forwarded);
      await this.dispatchEnvelopeEvent(
        'onForwardToPeerComplete',
        this,
        peerId,
        forwarded,
        undefined,
        undefined,
        context
      ).catch(() => undefined);

      this.trackFlowRoute(forwarded, connector);
      this.maybeForgetFlow(forwarded);
    }

    await this.dispatchEnvelopeEvent(
      'onForwardToPeersComplete',
      this,
      processed,
      peers ?? undefined,
      excludePeers ?? undefined,
      undefined,
      undefined,
      context
    ).catch(() => undefined);
  }

  override async forwardUpstream(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    if (context?.originType === DeliveryOriginType.UPSTREAM) {
      logger.debug('skipping_forward_upstream', {
        envp_id: envelope.id,
        origin_type: context.originType,
      });
      return;
    }

    let processed: FameEnvelope | null = null;
    try {
      processed = await this.dispatchEnvelopeEvent(
        'onForwardUpstream',
        this,
        envelope,
        context
      );
      if (!processed) {
        return;
      }

      const connector = this.upstreamConnector;
      const sessionManager = (
        this as unknown as { _sessionManager: SessionManager | null }
      )._sessionManager;
      const upstreamManager =
        sessionManager &&
        typeof (sessionManager as UpstreamSessionManager).send === 'function'
          ? (sessionManager as UpstreamSessionManager)
          : null;

      if (!connector || !upstreamManager) {
        await this.dispatchEnvelopeEvent(
          'onForwardUpstreamComplete',
          this,
          processed,
          undefined,
          undefined,
          context
        ).catch(() => undefined);
        return;
      }

      await upstreamManager.send(processed);
      this.trackFlowRoute(processed, connector);
      this.maybeForgetFlow(processed);

      await this.dispatchEnvelopeEvent(
        'onForwardUpstreamComplete',
        this,
        processed,
        undefined,
        undefined,
        context
      ).catch(() => undefined);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.dispatchEnvelopeEvent(
        'onForwardUpstreamComplete',
        this,
        processed ?? envelope,
        undefined,
        err,
        context
      ).catch(() => undefined);
      throw err;
    }
  }

  async createOriginConnector(
    options: OriginConnectorOptions
  ): Promise<FameConnector> {
    const normalizedOptions = normalizeOriginConnectorOptions(
      options as OriginConnectorOptions & Record<string, unknown>
    );
    const {
      connectorConfig,
      originType,
      systemId,
      authorization: authorizationOption,
      ...factoryArgs
    } = normalizedOptions;

    const connector = await createResource<FameConnector>(
      connectorConfig as ConnectorConfig,
      factoryArgs
    );

    const attachedEvent = new AsyncEvent();
    const buffer: FameEnvelope[] = [];

    const authorization = (authorizationOption ??
      null) as FameNodeAuthorizationContext | null;

    const buildContext = (
      ctx?: FameDeliveryContext | null
    ): FameAuthorizedDeliveryContext => {
      const baseSecurity = ctx?.security
        ? ({ ...ctx.security } as SecurityContext)
        : undefined;
      const security =
        baseSecurity || authorization !== null
          ? ({ ...(baseSecurity ?? {}), authorization } as SecurityContext & {
              authorization?: FameNodeAuthorizationContext | null;
            })
          : undefined;

      return {
        fromConnector: connector,
        fromSystemId: systemId,
        originType,
        expectedResponseType:
          ctx?.expectedResponseType ?? FameResponseType.NONE,
        security,
        meta: ctx?.meta,
        stickinessRequired: ctx?.stickinessRequired,
        stickySid: ctx?.stickySid,
      };
    };

    const gatedHandler: FameEnvelopeHandler = async (
      env: FameEnvelope,
      ctx?: FameDeliveryContext
    ) => {
      if (ctx?.fromConnector && ctx.fromConnector !== connector) {
        throw new Error('Context connector mismatch for origin connector');
      }
      if (ctx?.fromSystemId && ctx.fromSystemId !== systemId) {
        throw new Error('Context system id mismatch for origin connector');
      }
      if (ctx?.originType && ctx.originType !== originType) {
        throw new Error('Context origin type mismatch for origin connector');
      }

      const effectiveContext = buildContext(ctx);

      await this.dispatchEnvelopeEvent('onEnvelopeReceived', this, env, ctx);

      if (!attachedEvent.isSet()) {
        const frameType = env.frame?.type ?? '';
        if (ALLOWED_BEFORE_ATTACH.has(frameType)) {
          await this.deliver(env, effectiveContext);
        } else {
          buffer.push(env);
        }
        return null;
      }

      while (buffer.length) {
        const pending = buffer.shift();
        if (pending) {
          await this.deliver(pending, effectiveContext);
        }
      }

      await this.deliver(env, effectiveContext);
      return null;
    };

    await connector.start(gatedHandler);

    const pendingEntry: PendingRouteEntry = {
      connector,
      attached: {
        set: () => attachedEvent.set(),
        wait: (options?: { signal?: AbortSignal }) =>
          attachedEvent.wait(options),
      },
      buffer,
    };

    const timeoutMs = this.attachTimeoutMs;
    if (timeoutMs !== null && timeoutMs > 0) {
      const timeoutController = new AbortController();
      pendingEntry.cancelAttachTimeout = () => timeoutController.abort();

      this.spawn(
        async (taskSignal?: AbortSignal) => {
          const combined = new AbortController();
          const abortHandler = () => combined.abort();

          timeoutController.signal.addEventListener('abort', abortHandler);
          if (taskSignal) {
            if (taskSignal.aborted) {
              combined.abort();
            } else {
              taskSignal.addEventListener('abort', abortHandler);
            }
          }

          try {
            await delay(timeoutMs, combined.signal);
          } catch (error) {
            if (!combined.signal.aborted) {
              logger.debug('attach_timeout_delay_failed', {
                system_id: systemId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return;
          } finally {
            timeoutController.signal.removeEventListener('abort', abortHandler);
            taskSignal?.removeEventListener('abort', abortHandler);
          }

          let removed = false;
          await this.routeManager.routesLock.runExclusive(async () => {
            const current = this.routeManager._pending_routes.get(systemId);
            if (current === pendingEntry) {
              this.routeManager._pending_routes.delete(systemId);
              this.routeManager._pending_route_metadata.delete(systemId);
              removed = true;
            }
          });

          if (!removed) {
            return;
          }

          try {
            await connector.stop();
          } catch (error) {
            logger.debug('attach_timeout_stop_failed', {
              system_id: systemId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          logger.warning('attach_timeout_expired', {
            system_id: systemId,
            timeout_ms: timeoutMs,
          });
        },
        { name: `attach-timeout-${systemId}` }
      );
    }

    this.routeManager._pending_routes.set(systemId, pendingEntry);
    this.routeManager._pending_route_metadata.set(
      systemId,
      connectorConfig as ConnectorConfig
    );

    return connector;
  }

  childFor(address: FameAddress): string | null {
    const entry = this.routeManager._downstream_addresses_routes.get(
      address.toString()
    );
    return entry?.segment ?? null;
  }

  buildRouterState(): RouterState {
    const downstream = new Map<string, string>();
    for (const [
      addr,
      info,
    ] of this.routeManager._downstream_addresses_routes.entries()) {
      if (info?.segment) {
        downstream.set(addr, info.segment);
      }
    }

    return new RouterState({
      nodeId: this.id,
      local: this.bindingManager.getAddresses(),
      downstreamAddressRoutes: downstream,
      peerAddressRoutes: this.routeManager._peer_addresses_routes,
      childSegments: this.routeManager.downstreamRoutes.keys(),
      peerSegments: this.routeManager._peer_routes.keys(),
      hasParent: this.hasParent,
      physicalSegments: computePhysicalSegments(this.physicalPath),
      pools: this.getPoolsForRouter(),
      capabilities: this.capabilityFrameHandler.capRoutes,
      resolveAddressByCapability: this.resolveAddressByCapability.bind(this),
      envelopeFactory: this.envelopeFactory,
    });
  }

  private getPoolsForRouter(): Map<readonly [string, string], Set<string>> {
    const result = new Map<readonly [string, string], Set<string>>();
    for (const [
      poolKey,
      segments,
    ] of this.addressBindFrameHandler.pools.entries()) {
      result.set([poolKey.name, poolKey.pattern] as const, new Set(segments));
    }
    return result;
  }

  private async resolveAddressByCapability(
    capabilities: string[]
  ): Promise<FameAddress | null> {
    for (const capability of capabilities) {
      const routes = this.capabilityFrameHandler.capRoutes[capability];
      if (!routes) {
        continue;
      }
      for (const addressKey of Object.keys(routes)) {
        try {
          return new FameAddress(addressKey);
        } catch (error) {
          logger.debug('invalid_capability_address', {
            capability,
            address: addressKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return null;
  }

  async emitDeliveryNack(
    envelope: FameEnvelope,
    options: { code: string; context?: FameDeliveryContext | null }
  ): Promise<void> {
    const state = this.buildRouterState();
    await emitDeliveryNack(
      envelope,
      this,
      state,
      options.code,
      options.context ?? undefined
    );
  }

  async removeDownstreamRoute(
    segment: string,
    options: RouteRemovalOptions = {}
  ): Promise<void> {
    const { stop = true, delayMs, reason, meta, captureStack } = options;
    await this.routeManager.unregisterDownstreamRoute(segment, {
      stop,
      delayMs,
      reason: reason ?? 'sentinel.removeDownstreamRoute',
      meta: {
        ...(meta ?? {}),
        requested_stop: stop,
        caller: 'Sentinel.removeDownstreamRoute',
      },
      captureStack,
    });
  }

  async removePeerRoute(
    segment: string,
    options: RouteRemovalOptions = {}
  ): Promise<void> {
    const { stop = true, delayMs, reason, meta, captureStack } = options;
    await this.routeManager.unregisterPeerRoute(segment, {
      stop,
      delayMs,
      reason: reason ?? 'sentinel.removePeerRoute',
      meta: {
        ...(meta ?? {}),
        requested_stop: stop,
        caller: 'Sentinel.removePeerRoute',
      },
      captureStack,
    });
  }

  async resolveEncryptionKeyForAddress(
    _targetAddress: FameAddress
  ): Promise<string | null> {
    return null;
  }

  protected override async onDeliveryNack(
    frame: DeliveryAckFrame,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    await super.onDeliveryNack(frame, envelope, context);

    const corrId = envelope.corrId;
    if (!corrId || !this.pendingBinds.has(corrId)) {
      return;
    }

    await this.resolvePendingBind(envelope, false, frame.reason ?? null);
  }

  private get deliveryTracker(): DefaultDeliveryTracker {
    return (this as unknown as { _deliveryTracker: DefaultDeliveryTracker })
      ._deliveryTracker;
  }

  private originMatches(
    context: FameDeliveryContext | undefined,
    segment: string,
    originType: DeliveryOriginType
  ): boolean {
    return Boolean(
      context &&
        context.originType === originType &&
        context.fromSystemId === segment
    );
  }

  private trackFlowRoute(
    envelope: FameEnvelope,
    connector: FameConnector
  ): void {
    const flowId = envelope.flowId;
    if (!flowId || this.routeManager.getFlowRoute(flowId)) {
      return;
    }
    this.routeManager.trackFlowRoute(flowId, connector);
  }

  private maybeForgetFlow(envelope: FameEnvelope): void {
    const flowId = envelope.flowId;
    if (!flowId) {
      return;
    }
    if (envelope.flowFlags && envelope.flowFlags & FlowFlags.RESET) {
      this.routeManager.clearFlowRoute(flowId);
    }
  }

  private async resolvePendingBind(
    envelope: FameEnvelope,
    ok: boolean,
    reason?: string | null
  ): Promise<void> {
    const corrId = envelope.corrId;
    if (!corrId) {
      return;
    }

    await this.pendingLock.runExclusive(async () => {
      const pending = this.pendingBinds.get(corrId);
      if (!pending) {
        return;
      }
      this.pendingBinds.delete(corrId);
      if (ok) {
        pending.resolve(true);
      } else {
        pending.reject(new Error(reason ?? 'Bind rejected'));
      }
    });
  }

  private async connectToPeers(): Promise<void> {
    if (!this.peers.length) {
      return;
    }

    const tasks = this.peers.map((peer) => this.connectToPeer(peer));
    await Promise.all(tasks);
  }

  private async connectToPeer(peer: Peer): Promise<void> {
    if (!this.attachClient) {
      throw new Error('Missing attach client');
    }

    if (!peer.admissionClient) {
      throw new Error('Missing admission client');
    }

    const sessionManager = new UpstreamSessionManager({
      node: this,
      outboundOriginType: DeliveryOriginType.PEER,
      inboundOriginType: DeliveryOriginType.PEER,
      admissionClient: peer.admissionClient as AdmissionClient,
      attachClient: this.attachClient,
      requestedLogicals: this.requestedLogicals,
      inboundHandler: (env: FameEnvelope, ctx?: FameDeliveryContext) =>
        this.handleInboundFromPeer(env, ctx),
      onAttach: (info: AttachInfo, connector: FameConnector) =>
        this.onNodeAttachToPeer(info, connector),
      onEpochChange: (epoch: string) => this.onEpochChange(epoch),
      onWelcome: async () => undefined,
      retryPolicy: this.connectionRetryPolicy,
    });

    await sessionManager.start();
    const systemId = sessionManager.systemId;
    if (!systemId) {
      throw new Error('Peer session manager missing system id');
    }

    this.peerSessionManagers.set(systemId, sessionManager);
    await this.routeManager.registerPeerRoute(
      systemId,
      sessionManager as unknown as FameConnector
    );
  }

  private async handleInboundFromPeer(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameMessageResponse | null | undefined> {
    const deliveryContext: FameDeliveryContext = {
      expectedResponseType:
        context?.expectedResponseType ?? FameResponseType.NONE,
      fromConnector: context?.fromConnector,
      fromSystemId: context?.fromSystemId,
      originType: DeliveryOriginType.PEER,
      security: context?.security,
      meta: context?.meta,
      stickinessRequired: context?.stickinessRequired,
      stickySid: context?.stickySid,
    };
    await this.deliver(envelope, deliveryContext);
    return null;
  }

  private async onNodeAttachToPeer(
    info: AttachInfo,
    connector: FameConnector
  ): Promise<void> {
    await this.dispatchEvent('onNodeAttachToPeer', this, info, connector).catch(
      () => undefined
    );
  }

  private async onEpochChange(epoch: string): Promise<void> {
    this.routingEpochValue = epoch;
    await this.dispatchEvent('onEpochChange', this, epoch).catch(
      () => undefined
    );
    await this.propagateAddressBindingsUpstream();
  }

  private async propagateAddressBindingsUpstream(): Promise<void> {
    if (!this.hasParent) {
      logger.warning('No upstream defined to rebind addresses');
      return;
    }

    const entries = Array.from(
      this.routeManager._downstream_addresses_routes.entries()
    );
    for (const [address, info] of entries) {
      if (!info) {
        continue;
      }

      let name: string | null = null;
      try {
        const [parsedName] = parseAddress(address);
        name = parsedName;
      } catch {
        name = null;
      }

      if (name && RESERVED_UPSTREAM_ADDRESS_NAMES.has(name.toLowerCase())) {
        continue;
      }
      try {
        await this.bindAddressUpstream(new FameAddress(address), info);
      } catch (error) {
        logger.error('rebind_failed', {
          address,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async bindAddressUpstream(
    address: FameAddress,
    info: AddressRouteInfo
  ): Promise<void> {
    if (!this.hasParent) {
      return;
    }

    const corrId = generateId();
    const deferred = createDeferred<boolean>();

    await this.pendingLock.runExclusive(async () => {
      this.pendingBinds.set(corrId, deferred);
    });

    const frame: AddressBindFrame = {
      type: 'AddressBind',
      address: address.toString(),
    };

    if (info.physicalPath) {
      frame.physicalPath = info.physicalPath;
    }
    if (info.encryptionKeyId) {
      frame.encryptionKeyId = info.encryptionKeyId;
    }

    const replyTo = formatAddress(SYSTEM_INBOX, this.physicalPath);
    const envelopeOptions: Parameters<
      typeof this.envelopeFactory.createEnvelope
    >[0] = {
      frame,
      corrId,
      replyTo,
    };

    const traceId = currentTraceId();
    if (traceId) {
      envelopeOptions.traceId = traceId;
    }

    const envelope = this.envelopeFactory.createEnvelope(envelopeOptions);
    await this.forwardUpstream(envelope, localDeliveryContext(this.id));

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(`Timeout waiting for bind ack for ${address.toString()}`)
        );
      }, this.ackTimeoutMs);
      if (typeof (timeoutId as NodeJS.Timeout | null)?.unref === 'function') {
        (timeoutId as NodeJS.Timeout).unref();
      }
    });

    try {
      const result = await Promise.race([deferred.promise, timeoutPromise]);
      if (!result) {
        throw new Error(`Bind to ${address.toString()} was rejected`);
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      await this.pendingLock.runExclusive(async () => {
        const pending = this.pendingBinds.get(corrId);
        if (pending === deferred) {
          this.pendingBinds.delete(corrId);
        }
      });
    }
  }

  /**
   * Dispatches the onRoutingActionSelected event to all event listeners.
   *
   * This allows listeners (like DefaultSecurityManager) to authorize
   * routing actions and optionally replace them with Deny actions.
   *
   * The hook must return the RoutingAction to execute. If a listener returns
   * null, undefined, or throws, the router will execute a Drop action.
   *
   * @param envelope - The envelope being routed
   * @param selected - The RoutingAction selected by the routing policy
   * @param state - The current router state
   * @param context - Optional delivery context
   * @returns The RoutingAction to execute (never null/undefined)
   */
  private async dispatchRoutingActionSelected(
    envelope: FameEnvelope,
    selected: RoutingAction,
    state: RouterState,
    context?: FameDeliveryContext
  ): Promise<RoutingAction> {
    let currentAction = selected;

    for (const listener of this.eventListeners) {
      if (typeof listener.onRoutingActionSelected !== 'function') {
        continue;
      }

      try {
        const result = await listener.onRoutingActionSelected(
          this,
          envelope,
          currentAction,
          state,
          context
        );

        // null/undefined => treat as denial, execute Drop
        if (result == null) {
          return new Drop();
        }

        // Update current action for next listener in chain
        currentAction = result;
      } catch (error) {
        // Hook threw => treat as denial, execute Drop
        logger.warning('routing_action_hook_error', {
          envp_id: envelope.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return new Drop();
      }
    }

    return currentAction;
  }

  static async aserve(options: SentinelServeOptions = {}): Promise<void> {
    const {
      logLevel,
      rootConfig,
      config,
      node = null,
      fabric: providedFabric = null,
      signals = ['SIGINT', 'SIGTERM'],
      signal,
      ...fabricOptions
    } = options as SentinelServeOptions & {
      rootConfig?: Record<string, unknown> | FameConfig;
      [key: string]: unknown;
    };

    const resolvedLevel = normalizeServeLogLevel(logLevel) ?? LogLevel.INFO;
    basicConfig({ level: resolvedLevel });

    const processRef: NodeJS.Process | undefined =
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as any).process !== 'undefined'
        ? ((globalThis as any).process as NodeJS.Process)
        : undefined;

    if (
      !processRef ||
      typeof processRef.once !== 'function' ||
      typeof processRef.removeListener !== 'function'
    ) {
      throw new Error(
        'Sentinel.aserve requires a Node.js runtime with signal support'
      );
    }

    const abortSignal = signal ?? null;
    if (abortSignal?.aborted) {
      logger.info('shutdown_signal_received', { signal: 'abort' });
      return;
    }

    // Build fabric options, preferring rootConfig if provided
    const fabricCreateOptions: Record<string, unknown> = {
      ...fabricOptions,
    };

    if (rootConfig !== undefined) {
      fabricCreateOptions.rootConfig = rootConfig;
    } else if (config !== null && config !== undefined) {
      fabricCreateOptions.rootConfig = config;
    }

    if (node !== null) {
      fabricCreateOptions.node = node;
    }

    logger.debug('fabric_create_options', {
      hasRootConfig: 'rootConfig' in fabricCreateOptions,
      hasNode: 'node' in fabricCreateOptions,
      rootConfigKeys: fabricCreateOptions.rootConfig
        ? Object.keys(
            fabricCreateOptions.rootConfig as Record<string, unknown>
          ).join(',')
        : 'none',
      allKeys: Object.keys(fabricCreateOptions).join(','),
    });

    let stopResolve!: () => void;
    let stopResolved = false;
    const stopPromise = new Promise<void>((resolve) => {
      stopResolve = () => {
        if (!stopResolved) {
          stopResolved = true;
          resolve();
        }
      };
    });

    const listeners: Array<{ signal: NodeJS.Signals; listener: () => void }> =
      [];
    let abortListener: (() => void) | null = null;

    const cleanupListeners = (): void => {
      while (listeners.length) {
        const { signal: registeredSignal, listener } = listeners.pop()!;
        processRef.removeListener(registeredSignal, listener);
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };

    const registerSignalListeners = (): void => {
      for (const sig of signals) {
        const listener = () => {
          logger.info('shutdown_signal_received', { signal: sig });
          cleanupListeners();
          stopResolve();
        };
        listeners.push({ signal: sig, listener });
        processRef.once(sig, listener);
      }

      if (abortSignal) {
        abortListener = () => {
          logger.info('shutdown_signal_received', { signal: 'abort' });
          cleanupListeners();
          stopResolve();
        };
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    };

    // Use provided fabric or withFabric pattern for lifecycle management
    if (providedFabric) {
      // If a fabric is provided, use it directly without lifecycle management
      await providedFabric.enter();
      try {
        registerSignalListeners();
        logger.info('sentinel_live', {
          message: 'Node is live! Press Ctrl+C to stop.',
        });

        try {
          await stopPromise;
          logger.info('sentinel_shutdown_begin');
        } finally {
          cleanupListeners();
        }
      } finally {
        await providedFabric.exit();
      }
    } else {
      // Use withFabric pattern for automatic lifecycle management
      await withFabric(fabricCreateOptions, async () => {
        registerSignalListeners();
        logger.info('sentinel_live', {
          message: 'Node is live! Press Ctrl+C to stop.',
        });

        try {
          await stopPromise;
          logger.info('sentinel_shutdown_begin');
        } finally {
          cleanupListeners();
        }
      });
    }

    logger.info('sentinel_shutdown_complete');
  }
}

function normalizeServeLogLevel(
  level: SentinelServeOptions['logLevel']
): LogLevel | undefined {
  if (level === null || level === undefined) {
    return undefined;
  }

  if (typeof level === 'number' && Number.isFinite(level)) {
    return level as LogLevel;
  }

  if (typeof level === 'string') {
    const trimmed = level.trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return numeric as LogLevel;
    }
    const key = trimmed.toUpperCase();
    const value = (LogLevel as unknown as Record<string, LogLevel>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}
