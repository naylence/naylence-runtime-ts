import {
  AddressBindAckFrame,
  AddressBindFrame,
  AddressUnbindAckFrame,
  AddressUnbindFrame,
  DeliveryOriginType,
  FameResponseType,
  type FameDeliveryContext,
  type FameEnvelope,
  parseAddress,
  parseAddressComponents,
} from '@naylence/core';

import type { RoutingNodeLike } from '../node/routing-node-like.js';
import type { AddressRouteInfo } from './key-frame-handler.js';
import { getLogger } from '../util/logging.js';
import { isPoolLogical } from '../util/logicals.js';
import { normalizePath } from '../util/util.js';

type MaybePromise<T> = T | Promise<T>;

type RouteEntryLike =
  | {
      assigned_path?: string | null;
      assignedPath?: string | null;
    }
  | null
  | undefined;

type DownstreamRouteStoreLike =
  | Map<string, RouteEntryLike>
  | Record<string, RouteEntryLike>
  | {
      get: (key: string) => MaybePromise<RouteEntryLike>;
    };

type AddressRouteMapLike =
  | Map<string, AddressRouteInfo>
  | Record<string, AddressRouteInfo | undefined>
  | undefined;

type PeerRouteMapLike =
  | Map<string, string>
  | Record<string, string | undefined>
  | undefined;

type RouteRegistryLike =
  | Map<string, unknown>
  | Record<string, unknown>
  | undefined;

type DownstreamLegacyMapLike =
  | Map<string, unknown>
  | Record<string, unknown>
  | undefined;

export interface RouteManagerLike {
  downstreamRoutes?: RouteRegistryLike;
  downstream_routes?: RouteRegistryLike;
  _downstream_routes?: RouteRegistryLike;
  peerRoutes?: RouteRegistryLike;
  _peerRoutes?: RouteRegistryLike;
  _peer_routes?: RouteRegistryLike;
  _downstream_addresses_routes?: AddressRouteMapLike;
  downstreamAddressesRoutes?: AddressRouteMapLike;
  downstream_addresses_routes?: AddressRouteMapLike;
  _peer_addresses_routes?: PeerRouteMapLike;
  peerAddressesRoutes?: PeerRouteMapLike;
  peer_addresses_routes?: PeerRouteMapLike;
  _downstream_route_store?: DownstreamRouteStoreLike;
  downstreamRouteStore?: DownstreamRouteStoreLike;
  downstream_route_store?: DownstreamRouteStoreLike;
  _downstream_addresses_legacy?: DownstreamLegacyMapLike;
  downstreamAddressesLegacy?: DownstreamLegacyMapLike;
  downstream_addresses_legacy?: DownstreamLegacyMapLike;
}

export interface PoolKey {
  readonly name: string;
  readonly pattern: string;
}

const logger = getLogger('naylence.fame.sentinel.address_bind_frame_handler');
const RESERVED_ADDRESS_NAMES = new Set(['__sys__', '__rpc__']);

function pickManagerField<T>(
  manager: RouteManagerLike,
  keys: string[]
): T | undefined {
  const record = manager as Record<string, unknown>;
  for (const key of keys) {
    if (key in record) {
      const value = record[key];
      if (value !== undefined && value !== null) {
        return value as T;
      }
    }
  }
  return undefined;
}

function resolveDownstreamRoutes(
  manager: RouteManagerLike
): RouteRegistryLike | undefined {
  return pickManagerField<RouteRegistryLike>(manager, [
    'downstreamRoutes',
    'downstream_routes',
    '_downstream_routes',
  ]);
}

function resolvePeerRoutes(
  manager: RouteManagerLike
): RouteRegistryLike | undefined {
  return pickManagerField<RouteRegistryLike>(manager, [
    '_peer_routes',
    'peerRoutes',
    '_peerRoutes',
  ]);
}

function resolveDownstreamAddressRoutes(
  manager: RouteManagerLike
): AddressRouteMapLike | undefined {
  return pickManagerField<AddressRouteMapLike>(manager, [
    '_downstream_addresses_routes',
    'downstreamAddressesRoutes',
    'downstream_addresses_routes',
  ]);
}

function resolvePeerAddressRoutes(
  manager: RouteManagerLike
): PeerRouteMapLike | undefined {
  return pickManagerField<PeerRouteMapLike>(manager, [
    '_peer_addresses_routes',
    'peerAddressesRoutes',
    'peer_addresses_routes',
  ]);
}

function resolveDownstreamRouteStore(
  manager: RouteManagerLike
): DownstreamRouteStoreLike | undefined {
  return pickManagerField<DownstreamRouteStoreLike>(manager, [
    '_downstream_route_store',
    'downstreamRouteStore',
    'downstream_route_store',
  ]);
}

function resolveDownstreamLegacyRoutes(
  manager: RouteManagerLike
): DownstreamLegacyMapLike | undefined {
  return pickManagerField<DownstreamLegacyMapLike>(manager, [
    '_downstream_addresses_legacy',
    'downstreamAddressesLegacy',
    'downstream_addresses_legacy',
  ]);
}

function getContextOriginType(
  context: FameDeliveryContext | undefined
): DeliveryOriginType | null {
  if (!context) {
    return null;
  }
  const typed = context as FameDeliveryContext & {
    origin_type?: DeliveryOriginType | null;
  };
  return typed.originType ?? typed.origin_type ?? null;
}

function getEncryptionKeyIdFromFrame(frame: AddressBindFrame): string | null {
  const typed = frame as AddressBindFrame & {
    encryption_key_id?: string | null;
  };
  const candidate = typed.encryptionKeyId ?? typed.encryption_key_id ?? null;
  if (typeof candidate === 'string' && candidate.length) {
    return candidate;
  }
  return null;
}

function hasRoute(container: RouteRegistryLike, key: string): boolean {
  if (!container) {
    return false;
  }
  if (container instanceof Map) {
    return container.has(key);
  }
  if (typeof container === 'object') {
    return Object.prototype.hasOwnProperty.call(container, key);
  }
  return false;
}

function setAddressRoute(
  container: AddressRouteMapLike,
  key: string,
  value: AddressRouteInfo
): void {
  if (!container) {
    return;
  }
  if (container instanceof Map) {
    container.set(key, value);
  } else if (typeof container === 'object') {
    container[key] = value;
  }
}

function getAddressRoute(
  container: AddressRouteMapLike,
  key: string
): AddressRouteInfo | null {
  if (!container) {
    return null;
  }
  if (container instanceof Map) {
    return container.get(key) ?? null;
  }
  if (typeof container === 'object') {
    return container[key] ?? null;
  }
  return null;
}

function deleteAddressRoute(container: AddressRouteMapLike, key: string): void {
  if (!container) {
    return;
  }
  if (container instanceof Map) {
    container.delete(key);
  } else if (typeof container === 'object') {
    delete container[key];
  }
}

function deleteLegacyRoute(
  container: DownstreamLegacyMapLike,
  key: string
): void {
  if (!container) {
    return;
  }
  if (container instanceof Map) {
    container.delete(key);
  } else if (typeof container === 'object') {
    delete container[key];
  }
}

function setPeerRoute(
  container: PeerRouteMapLike,
  key: string,
  value: string
): void {
  if (!container) {
    return;
  }
  if (container instanceof Map) {
    container.set(key, value);
  } else if (typeof container === 'object') {
    container[key] = value;
  }
}

async function getDownstreamRouteEntry(
  store: DownstreamRouteStoreLike | undefined,
  key: string
): Promise<RouteEntryLike> {
  if (!store) {
    return null;
  }
  if (store instanceof Map) {
    return store.get(key) ?? null;
  }
  if (
    typeof store === 'object' &&
    'get' in store &&
    typeof store.get === 'function'
  ) {
    return await store.get(key);
  }
  if (typeof store === 'object') {
    return (store as Record<string, RouteEntryLike>)[key] ?? null;
  }
  return null;
}

function extractAssignedPath(entry: RouteEntryLike): string | null {
  if (!entry) {
    return null;
  }
  if (typeof entry.assignedPath === 'string') {
    return entry.assignedPath;
  }
  if (typeof entry.assigned_path === 'string') {
    return entry.assigned_path;
  }
  return null;
}

function createPoolKey(name: string, pattern: string): PoolKey {
  return { name, pattern };
}

function findPoolEntryKey(
  map: Map<PoolKey, Set<string>>,
  key: PoolKey
): PoolKey | undefined {
  for (const existing of map.keys()) {
    if (existing.name === key.name && existing.pattern === key.pattern) {
      return existing;
    }
  }
  return undefined;
}

function isReservedAddressName(name: string | null): boolean {
  if (!name) {
    return false;
  }
  return RESERVED_ADDRESS_NAMES.has(name.toLowerCase());
}

export class AddressBindFrameHandler {
  private readonly routingNode: RoutingNodeLike;
  private readonly routeManager: RouteManagerLike;
  private readonly upstreamConnector: () => unknown;
  private readonly poolsMap = new Map<PoolKey, Set<string>>();

  constructor(options: {
    routingNode: RoutingNodeLike;
    routeManager: RouteManagerLike;
    upstreamConnector: () => unknown;
  }) {
    this.routingNode = options.routingNode;
    this.routeManager = options.routeManager;
    this.upstreamConnector = options.upstreamConnector;
  }

  public get pools(): Map<PoolKey, Set<string>> {
    return this.poolsMap;
  }

  public async acceptAddressBind(
    envelope: FameEnvelope,
    context: FameDeliveryContext | undefined
  ): Promise<void> {
    const originType = getContextOriginType(context);

    if (!originType) {
      throw new Error(
        'AddressBind handling requires delivery context with originType'
      );
    }

    const frame = envelope.frame as AddressBindFrame | undefined;
    if (!frame || frame.type !== 'AddressBind') {
      throw new Error(
        `Expected AddressBindFrame, got ${frame?.type ?? 'unknown'}`
      );
    }

    const sourceSystemId = this.getSourceSystemId(context);
    if (!sourceSystemId) {
      return;
    }

    const downstreamRoutes = resolveDownstreamRoutes(this.routeManager);
    if (
      originType === DeliveryOriginType.DOWNSTREAM &&
      !hasRoute(downstreamRoutes, sourceSystemId)
    ) {
      throw new Error(
        `Cannot accept address bind from unknown downstream system ${sourceSystemId}`
      );
    }

    const peerRoutes = resolvePeerRoutes(this.routeManager);
    if (
      originType === DeliveryOriginType.PEER &&
      !hasRoute(peerRoutes, sourceSystemId)
    ) {
      throw new Error(
        `Cannot accept address bind from unknown peer system ${sourceSystemId}`
      );
    }

    const addressStr = frame.address.toString();
    const [name, location] = parseAddress(addressStr);

    let host: string | null = null;
    let isHostBased = false;
    try {
      const [, parsedHost] = parseAddressComponents(addressStr);
      if (parsedHost) {
        host = parsedHost;
        isHostBased = true;
      }
    } catch {
      host = null;
      isHostBased = false;
    }

    const isReservedAddress = isReservedAddressName(name);

    let isPoolBind = false;
    let poolKey: PoolKey | null = null;

    if (isHostBased && host && isPoolLogical(host)) {
      isPoolBind = true;
      poolKey = createPoolKey(name, host);
    } else if (
      !isHostBased &&
      (location.endsWith('/*') || location.endsWith('/**'))
    ) {
      const trimmed = location.endsWith('/*')
        ? location.slice(0, -2)
        : location.slice(0, -3);
      const root = normalizePath(trimmed);
      isPoolBind = true;
      poolKey = createPoolKey(name, root);
    }

    let ack: AddressBindAckFrame;

    const upstreamConnector = this.upstreamConnector();
    const shouldForwardUpstream =
      Boolean(upstreamConnector) && !isReservedAddress;

    if (isPoolBind && poolKey) {
      const existingKey = findPoolEntryKey(this.poolsMap, poolKey) ?? poolKey;
      const segments = this.poolsMap.get(existingKey) ?? new Set<string>();
      segments.add(sourceSystemId);
      if (!this.poolsMap.has(existingKey)) {
        this.poolsMap.set(existingKey, segments);
      }

      ack = {
        type: 'AddressBindAck',
        address: addressStr,
        ok: true,
        refId: envelope.id,
      };
    } else {
      let physicalPath: string | null = null;

      if (originType === DeliveryOriginType.DOWNSTREAM) {
        const routeEntry = await getDownstreamRouteEntry(
          resolveDownstreamRouteStore(this.routeManager),
          sourceSystemId
        );
        physicalPath = extractAssignedPath(routeEntry);
      }

      const routeInfo: AddressRouteInfo = {
        segment: sourceSystemId,
      };
      if (physicalPath) {
        routeInfo.physicalPath = physicalPath;
      }
      const encryptionKeyId = getEncryptionKeyIdFromFrame(frame);
      if (encryptionKeyId) {
        routeInfo.encryptionKeyId = encryptionKeyId;
      }

      if (originType === DeliveryOriginType.DOWNSTREAM) {
        setAddressRoute(
          resolveDownstreamAddressRoutes(this.routeManager),
          addressStr,
          routeInfo
        );
      } else if (originType === DeliveryOriginType.PEER) {
        setPeerRoute(
          resolvePeerAddressRoutes(this.routeManager),
          addressStr,
          sourceSystemId
        );
      } else {
        throw new Error('Unsupported origin type for address bind');
      }

      ack = {
        type: 'AddressBindAck',
        address: addressStr,
        ok: true,
        refId: envelope.id,
      };
    }

    if (originType === DeliveryOriginType.DOWNSTREAM && context) {
      const routingNodeId =
        typeof this.routingNode.id === 'string' && this.routingNode.id
          ? this.routingNode.id
          : 'sentinel';

      const ackContext: FameDeliveryContext = {
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: routingNodeId,
        security: context.security,
        meta: { 'message-type': 'response' },
        expectedResponseType: FameResponseType.NONE,
      };

      const ackEnvelope = this.routingNode.envelopeFactory.createEnvelope({
        frame: ack,
        ...(envelope.corrId ? { corrId: envelope.corrId } : {}),
      });

      if (!this.routingNode.forwardToRoute) {
        throw new Error('Routing node does not support forwardToRoute');
      }

      await this.routingNode.forwardToRoute(
        sourceSystemId,
        ackEnvelope,
        ackContext
      );
    }

    if (shouldForwardUpstream) {
      await this.routingNode.forwardUpstream(envelope, context);
    }

    if (this.routingNode.forwardToPeers) {
      await this.routingNode.forwardToPeers(
        envelope,
        undefined,
        [sourceSystemId],
        context
      );
    }

    logger.debug('address_bound', {
      address: addressStr,
      segment: sourceSystemId,
    });
  }

  public async acceptAddressUnbind(
    envelope: FameEnvelope,
    context: FameDeliveryContext | undefined
  ): Promise<void> {
    const frame = envelope.frame as AddressUnbindFrame | undefined;
    if (!frame || frame.type !== 'AddressUnbind') {
      throw new Error(
        `Expected AddressUnbindFrame, got ${frame?.type ?? 'unknown'}`
      );
    }

    const sourceSystemId = this.getSourceSystemId(context);
    if (!sourceSystemId) {
      return;
    }

    const addressStr = frame.address.toString();
    const [name, location] = parseAddress(addressStr);

    let host: string | null = null;
    let isHostBased = false;
    try {
      const [, parsedHost] = parseAddressComponents(addressStr);
      if (parsedHost) {
        host = parsedHost;
        isHostBased = true;
      }
    } catch {
      host = null;
      isHostBased = false;
    }

    let isPoolUnbind = false;
    let poolKey: PoolKey | null = null;

    if (isHostBased && host && isPoolLogical(host)) {
      isPoolUnbind = true;
      poolKey = createPoolKey(name, host);
    } else if (
      !isHostBased &&
      (location.endsWith('/*') || location.endsWith('/**'))
    ) {
      const trimmed = location.endsWith('/*')
        ? location.slice(0, -2)
        : location.slice(0, -3);
      const root = normalizePath(trimmed);
      isPoolUnbind = true;
      poolKey = createPoolKey(name, root);
    }

    const upstreamConnector = this.upstreamConnector();
    const originType = getContextOriginType(context);
    const shouldForwardUpstream =
      Boolean(upstreamConnector) && !isReservedAddressName(name);

    if (isPoolUnbind && poolKey) {
      const existingKey = findPoolEntryKey(this.poolsMap, poolKey);
      if (existingKey) {
        const segments = this.poolsMap.get(existingKey);
        if (segments && segments.has(sourceSystemId)) {
          segments.delete(sourceSystemId);
          if (!segments.size) {
            this.poolsMap.delete(existingKey);
          }
          if (shouldForwardUpstream) {
            await this.routingNode.forwardUpstream(envelope, context);
          }
        }
      }
    } else {
      const routeInfo = getAddressRoute(
        resolveDownstreamAddressRoutes(this.routeManager),
        addressStr
      );
      if (routeInfo?.segment === sourceSystemId) {
        deleteAddressRoute(
          resolveDownstreamAddressRoutes(this.routeManager),
          addressStr
        );
        deleteLegacyRoute(
          resolveDownstreamLegacyRoutes(this.routeManager),
          addressStr
        );
        if (shouldForwardUpstream) {
          await this.routingNode.forwardUpstream(envelope, context);
        }
      }
    }

    if (context && originType === DeliveryOriginType.DOWNSTREAM) {
      const routingNodeId =
        typeof this.routingNode.id === 'string' && this.routingNode.id
          ? this.routingNode.id
          : 'sentinel';

      const ack: AddressUnbindAckFrame = {
        type: 'AddressUnbindAck',
        address: addressStr,
        ok: true,
        refId: envelope.id,
      };

      const ackContext: FameDeliveryContext = {
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: routingNodeId,
        security: context.security,
        meta: { 'message-type': 'response' },
        expectedResponseType: FameResponseType.NONE,
      };

      const ackEnvelope = this.routingNode.envelopeFactory.createEnvelope({
        frame: ack,
        ...(envelope.corrId ? { corrId: envelope.corrId } : {}),
      });

      if (!this.routingNode.forwardToRoute) {
        throw new Error('Routing node does not support forwardToRoute');
      }

      await this.routingNode.forwardToRoute(
        sourceSystemId,
        ackEnvelope,
        ackContext
      );
    }

    logger.debug('address_unbound', {
      address: addressStr,
      segment: sourceSystemId,
    });
  }

  private getSourceSystemId(
    context: FameDeliveryContext | undefined
  ): string | null {
    if (!context) {
      return null;
    }

    const typed = context as FameDeliveryContext & {
      from_system_id?: string | null;
    };

    const candidate = typed.fromSystemId ?? typed.from_system_id ?? null;

    if (typeof candidate === 'string' && candidate.length) {
      return candidate;
    }

    return null;
  }
}
