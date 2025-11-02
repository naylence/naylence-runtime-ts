import {
  DeliveryAckFrame,
  FlowFlags,
  FameEnvelope,
  FameDeliveryContext,
  FameAddress,
  localDeliveryContext,
  parseAddress,
  type DataFrame,
  type SecureOpenFrame,
  type SecureAcceptFrame,
  type EnvelopeFactory,
} from '@naylence/core';

import { FameTransportClose } from '../errors/errors.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import { getLogger, summarizeEnvelope } from '../util/logging.js';

const logger = getLogger('naylence.fame.sentinel.router');

const ZERO_EPH_PUB_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export type PoolKey = readonly [string, string];

export type ResolveAddressByCapability = (
  capabilities: string[]
) => Promise<FameAddress | null>;

interface RouterStateOptions {
  nodeId: string;
  local: Iterable<FameAddress | string>;
  downstreamAddressRoutes:
    | Map<FameAddress | string, string>
    | Record<string, string>;
  peerAddressRoutes?:
    | Map<FameAddress | string, string>
    | Record<string, string>;
  childSegments: Iterable<string>;
  peerSegments: Iterable<string>;
  hasParent: boolean;
  physicalSegments: string[];
  pools: Map<PoolKey, Set<string>> | Record<string, Set<string>>;
  capabilities?: RouterCapabilitiesMap;
  resolveAddressByCapability?: ResolveAddressByCapability;
  envelopeFactory?: EnvelopeFactory;
}

interface RouterStateSnakeCaseOptions {
  node_id: string;
  local: Iterable<FameAddress | string>;
  downstream_address_routes:
    | Map<FameAddress | string, string>
    | Record<string, string>;
  peer_address_routes?:
    | Map<FameAddress | string, string>
    | Record<string, string>;
  child_segments: Iterable<string>;
  peer_segments: Iterable<string>;
  has_parent: boolean;
  physical_segments: string[];
  pools: Map<PoolKey, Set<string>> | Record<string, Set<string>>;
  capabilities?: RouterCapabilitiesMap;
  resolve_address_by_capability?: ResolveAddressByCapability;
  envelope_factory?: EnvelopeFactory;
}

type RouterStateInit = RouterStateOptions | RouterStateSnakeCaseOptions;

export interface RoutingAction {
  execute(
    envelope: FameEnvelope,
    router: RoutingNodeLike,
    state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<void>;
}

export class Drop implements RoutingAction {
  public async execute(
    envelope: FameEnvelope,
    router: RoutingNodeLike,
    state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<void> {
    await emitDeliveryNack(
      envelope,
      router,
      state,
      'NO_ROUTE',
      context ?? undefined
    );
    logger.debug(
      'dropped_envelope',
      Object.assign(summarizeEnvelope(envelope, ''), {
        localAddresses: Array.from(state.local.values()),
        downstreamRoutes: Array.from(state.downstreamAddressRoutes.entries()),
        peerRoutes: Array.from(state.peerAddressRoutes.entries()),
      })
    );
  }
}

export class ForwardUp implements RoutingAction {
  public async execute(
    envelope: FameEnvelope,
    router: RoutingNodeLike,
    _state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<void> {
    await router.forwardUpstream(envelope, context ?? undefined);
  }
}

export class DeliverLocal implements RoutingAction {
  constructor(private readonly recipient: FameAddress) {}

  public async execute(
    envelope: FameEnvelope,
    router: RoutingNodeLike,
    _state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<void> {
    await router.deliverLocal(this.recipient, envelope, context ?? undefined);
  }
}

export class ForwardChild implements RoutingAction {
  constructor(private readonly segment: string) {}

  public async execute(
    envelope: FameEnvelope,
    router: RoutingNodeLike,
    state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<void> {
    try {
      await router.forwardToRoute?.(
        this.segment,
        envelope,
        context ?? undefined
      );
    } catch (error) {
      if (error instanceof FameTransportClose) {
        logger.error('transport_closed_forward_child', {
          segment: this.segment,
          error: error.message,
        });
        await router.removeDownstreamRoute?.(this.segment, {
          reason: 'transport_closed_forward_child',
          meta: {
            segment: this.segment,
            envelope_id: envelope.id,
            frame_type: envelope.frame?.type ?? null,
          },
          captureStack: false,
        });
        if (!isDeliveryAck(envelope.frame)) {
          await emitDeliveryNack(
            envelope,
            router,
            state,
            'ROUTE_CONNECTOR_CLOSED',
            context ?? undefined
          );
        }
        return;
      }
      throw error;
    }
  }
}

export class ForwardPeer implements RoutingAction {
  constructor(private readonly segment: string) {}

  public async execute(
    envelope: FameEnvelope,
    router: RoutingNodeLike,
    state: RouterState,
    context?: FameDeliveryContext | null
  ): Promise<void> {
    try {
      await router.forwardToPeer?.(
        this.segment,
        envelope,
        context ?? undefined
      );
    } catch (error) {
      if (error instanceof FameTransportClose) {
        logger.error('transport_closed_forward_peer', {
          segment: this.segment,
          error: error.message,
        });
        await router.removePeerRoute?.(this.segment, {
          reason: 'transport_closed_forward_peer',
          meta: {
            segment: this.segment,
            envelope_id: envelope.id,
            frame_type: envelope.frame?.type ?? null,
          },
          captureStack: false,
        });
        if (!isDeliveryAck(envelope.frame)) {
          await emitDeliveryNack(
            envelope,
            router,
            state,
            'ROUTE_CONNECTOR_CLOSED',
            context ?? undefined
          );
        }
        return;
      }
      throw error;
    }
  }
}

export interface RouterCapabilitiesMap {
  [capability: string]: Record<string, string>;
}

export class RouterState {
  public readonly nodeId: string;
  public readonly local: ReadonlySet<string>;
  public readonly downstreamAddressRoutes: ReadonlyMap<string, string>;
  public readonly peerAddressRoutes: ReadonlyMap<string, string>;
  public readonly childSegments: ReadonlySet<string>;
  public readonly peerSegments: ReadonlySet<string>;
  public readonly hasParent: boolean;
  public readonly physicalSegments: readonly string[];
  public readonly capabilities: RouterCapabilitiesMap;
  public readonly pools: ReadonlyMap<PoolKey, ReadonlySet<string>>;
  public readonly resolveAddressByCapability: ResolveAddressByCapability | null;
  public readonly envelopeFactory: EnvelopeFactory | null;

  constructor(options: RouterStateInit) {
    const normalized = normalizeRouterStateOptions(options);
    this.nodeId = normalized.nodeId;
    this.local = new Set(
      Array.from(normalized.local, (address) => normalizeAddressKey(address))
    );
    this.downstreamAddressRoutes = toReadOnlyMap(
      normalized.downstreamAddressRoutes
    );
    this.peerAddressRoutes = toReadOnlyMap(
      normalized.peerAddressRoutes ?? new Map<FameAddress | string, string>()
    );
    this.childSegments = new Set(normalized.childSegments);
    this.peerSegments = new Set(normalized.peerSegments);
    this.hasParent = normalized.hasParent;
    this.physicalSegments = [...normalized.physicalSegments];
    this.pools = toPoolMap(normalized.pools);
    this.capabilities = normalized.capabilities ?? {};
    this.resolveAddressByCapability =
      normalized.resolveAddressByCapability ?? null;
    this.envelopeFactory = normalized.envelopeFactory ?? null;
  }

  public nextHop(fullPath: string): string | null {
    const relative = stripSelfPrefix(fullPath, this.physicalSegments);
    return relative[0] ?? null;
  }
}

export async function emitDeliveryNack(
  envelope: FameEnvelope,
  routingNode: RoutingNodeLike,
  state: RouterState,
  code: string,
  context?: FameDeliveryContext
): Promise<void> {
  const targetAddress = envelope.replyTo;

  if (!shouldEmitNack(envelope) || !targetAddress) {
    return;
  }

  if (!state.envelopeFactory) {
    logger.warning(
      'router_missing_envelope_factory',
      summarizeEnvelope(envelope)
    );
    return;
  }

  const nackFrame = createNackFrame(envelope, code);
  const targetKey = normalizeAddressKey(targetAddress);

  const nackEnvelope = state.envelopeFactory.createEnvelope({
    to: targetAddress,
    frame: nackFrame,
    flags: FlowFlags.RESET,
    corrId: envelope.corrId!,
  });

  try {
    if (state.local.has(targetKey)) {
      await routingNode.deliverLocal(targetAddress, nackEnvelope, context);
      return;
    }

    const [, targetPath] = parseAddress(targetKey);
    const remainder = stripSelfPrefix(targetPath, state.physicalSegments);
    const firstSegment = remainder[0];

    const deliveryContext = localDeliveryContext(state.nodeId);

    if (firstSegment && state.childSegments.has(firstSegment)) {
      await routingNode.forwardToRoute?.(
        firstSegment,
        nackEnvelope,
        deliveryContext
      );
    } else if (firstSegment && state.peerSegments.has(firstSegment)) {
      await routingNode.forwardToPeer?.(
        firstSegment,
        nackEnvelope,
        deliveryContext
      );
    } else {
      await routingNode.forwardUpstream(nackEnvelope, deliveryContext);
    }
  } catch (error) {
    logger.warning('nack_forward_failed', {
      error: error instanceof Error ? error.message : String(error),
      ...summarizeEnvelope(envelope),
    });
  }
}

function shouldEmitNack(envelope: FameEnvelope): boolean {
  return (
    (isDataFrame(envelope.frame) || isSecureOpenFrame(envelope.frame)) &&
    Boolean(envelope.id) &&
    Boolean(envelope.replyTo) &&
    Boolean(envelope.corrId)
  );
}

function createNackFrame(
  envelope: FameEnvelope,
  code: string
): DeliveryAckFrame | SecureAcceptFrame {
  if (isSecureOpenFrame(envelope.frame)) {
    return {
      type: 'SecureAccept',
      cid: envelope.frame.cid,
      ephPub: ZERO_EPH_PUB_BASE64,
      ok: false,
      refId: envelope.id!,
      reason: `Channel handshake failed: ${code} - Unroutable to ${envelope.to}`,
      alg: envelope.frame.alg,
    } satisfies SecureAcceptFrame;
  }

  return {
    type: 'DeliveryAck',
    ok: false,
    code,
    refId: envelope.id!,
    reason: `Unroutable to ${String(envelope.to ?? envelope.replyTo ?? '')}`,
  } satisfies DeliveryAckFrame;
}

function stripSelfPrefix(
  path: string,
  selfSegments: readonly string[]
): string[] {
  const segments = path.replace(/^\/+/, '').split('/').filter(Boolean);
  if (
    segments.slice(0, selfSegments.length).join('/') === selfSegments.join('/')
  ) {
    return segments.slice(selfSegments.length);
  }
  return segments;
}

function toReadOnlyMap<V>(
  source: Map<FameAddress | string, V> | Record<string, V>
): ReadonlyMap<string, V> {
  const map = new Map<string, V>();

  if (source instanceof Map) {
    for (const [key, value] of source.entries()) {
      map.set(normalizeAddressKey(key), value);
    }
    return map;
  }

  for (const [key, value] of Object.entries(source)) {
    map.set(key, value);
  }
  return map;
}

function toPoolMap(
  source: Map<PoolKey, Set<string>> | Record<string, Set<string>>
): ReadonlyMap<PoolKey, ReadonlySet<string>> {
  const map = new Map<PoolKey, ReadonlySet<string>>();

  if (source instanceof Map) {
    for (const [key, value] of source.entries()) {
      map.set(key, new Set(value));
    }
    return map;
  }

  for (const [key, value] of Object.entries(source)) {
    const [name, pattern] = key.split('::');
    map.set([name, pattern], new Set(value));
  }
  return map;
}

function isDeliveryAck(
  frame: FameEnvelope['frame']
): frame is DeliveryAckFrame {
  return frame?.type === 'DeliveryAck';
}

function isDataFrame(frame: FameEnvelope['frame']): frame is DataFrame {
  return frame?.type === 'Data';
}

function normalizeRouterStateOptions(
  options: RouterStateInit
): RouterStateOptions {
  if ('nodeId' in options) {
    return options;
  }

  return {
    nodeId: options.node_id,
    local: options.local,
    downstreamAddressRoutes: options.downstream_address_routes,
    peerAddressRoutes: options.peer_address_routes,
    childSegments: options.child_segments,
    peerSegments: options.peer_segments,
    hasParent: options.has_parent,
    physicalSegments: options.physical_segments,
    pools: options.pools,
    capabilities: options.capabilities,
    resolveAddressByCapability: options.resolve_address_by_capability,
    envelopeFactory: options.envelope_factory,
  } satisfies RouterStateOptions;
}

function isSecureOpenFrame(
  frame: FameEnvelope['frame']
): frame is SecureOpenFrame {
  return frame?.type === 'SecureOpen';
}

function normalizeAddressKey(address: FameAddress | string): string {
  return typeof address === 'string' ? address : address.toString();
}
