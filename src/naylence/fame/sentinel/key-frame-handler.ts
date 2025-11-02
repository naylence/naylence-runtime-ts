import {
  DeliveryOriginType,
  FameAddress,
  type FameDeliveryContext,
  type FameEnvelope,
  type KeyAnnounceFrame,
  type KeyRequestFrame,
} from '@naylence/core';

import { KeyCorrelationMap } from './key-correlation-map.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import type { BindingManager } from '../node/binding-manager.js';
import type { KeyManager } from '../security/keys/key-manager.js';
import type { KeyRecord } from '../security/keys/key-store.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.sentinel.key_frame_handler');

export interface AddressRouteInfo {
  segment?: string | null;
  physicalPath?: string | null;
  encryptionKeyId?: string | null;
  lastUpdated?: Date | null;
}

interface RouteManagerLike {
  downstreamRoutes?: Map<string, unknown> | Record<string, unknown>;
  _downstream_addresses_routes?:
    | Map<string, AddressRouteInfo>
    | Record<string, AddressRouteInfo>;
  _peer_routes?: Map<string, unknown> | Record<string, unknown>;
  _peer_addresses_routes?: Map<string, string> | Record<string, string>;
  [key: string]: unknown;
}

type AcceptKeyAnnounceParent = (
  envelope: FameEnvelope,
  context: FameDeliveryContext
) => Promise<void>;

type SpawnFunction = (
  task: () => Promise<void>,
  options?: { name?: string }
) => Promise<unknown> | unknown;

function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return Boolean(value) && typeof (value as Promise<T>).then === 'function';
}

function toRouteMap(
  mapLike:
    | Map<string, AddressRouteInfo>
    | Record<string, AddressRouteInfo>
    | undefined
): Map<string, AddressRouteInfo> {
  if (!mapLike) {
    return new Map();
  }
  if (mapLike instanceof Map) {
    return new Map(mapLike);
  }
  const result = new Map<string, AddressRouteInfo>();
  for (const [key, value] of Object.entries(mapLike)) {
    if (value) {
      result.set(key, value);
    }
  }
  return result;
}

function toStringMap(
  mapLike: Map<string, string> | Record<string, string> | undefined
): Map<string, string> {
  if (!mapLike) {
    return new Map();
  }
  if (mapLike instanceof Map) {
    return new Map(mapLike);
  }
  return new Map(Object.entries(mapLike));
}

function toRecordKeys(source: Iterable<KeyRecord>): KeyRecord[] {
  return Array.from(source);
}

function getRouteManagerField<T>(
  routeManager: RouteManagerLike | null | undefined,
  keys: string[]
): T | undefined {
  if (!routeManager) {
    return undefined;
  }

  const record = routeManager as Record<string, unknown>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const value = record[key];
      if (value !== undefined && value !== null) {
        return value as T;
      }
    }
  }

  return undefined;
}

function resolveOriginType(raw: unknown): DeliveryOriginType | null {
  if (raw == null) {
    return null;
  }

  const deliveryValues = Object.values(
    DeliveryOriginType
  ) as DeliveryOriginType[];

  if (deliveryValues.includes(raw as DeliveryOriginType)) {
    return raw as DeliveryOriginType;
  }

  if (typeof raw === 'string') {
    const exact = deliveryValues.find((value) => value === raw);
    if (exact) {
      return exact;
    }

    const lowerMatch = deliveryValues.find(
      (value) => value.toLowerCase() === raw.toLowerCase()
    );
    if (lowerMatch) {
      return lowerMatch;
    }

    const enumMatch = Object.entries(DeliveryOriginType).find(
      ([key]) => key.toLowerCase() === raw.toLowerCase()
    );
    if (enumMatch) {
      return enumMatch[1] as DeliveryOriginType;
    }

    return raw as DeliveryOriginType;
  }

  return null;
}

function updateStickinessAliases(
  context: FameDeliveryContext,
  stickySid: string | null | undefined
): void {
  (context as any).stickiness_required = true;
  if (stickySid == null) {
    context.stickySid = undefined;
    (context as any).sticky_sid = undefined;
  } else {
    context.stickySid = stickySid;
    (context as any).sticky_sid = stickySid;
  }
}

export class KeyFrameHandler {
  private readonly routingNode: RoutingNodeLike;
  private readonly routeManager: RouteManagerLike | null;
  private readonly bindingManager: BindingManager;
  private readonly acceptKeyAnnounceParent: AcceptKeyAnnounceParent;
  private readonly keyManager: KeyManager | null;
  private readonly correlationMap: KeyCorrelationMap;

  private cleanupAbortController: AbortController | null = null;
  private cleanupTask: Promise<unknown> | null = null;

  constructor(options: {
    routingNode: RoutingNodeLike;
    routeManager: RouteManagerLike | null;
    bindingManager: BindingManager;
    acceptKeyAnnounceParent: AcceptKeyAnnounceParent;
    keyManager?: KeyManager | null;
    correlationMap?: KeyCorrelationMap;
  }) {
    this.routingNode = options.routingNode;
    this.routeManager = options.routeManager;
    this.bindingManager = options.bindingManager;
    this.acceptKeyAnnounceParent = options.acceptKeyAnnounceParent;
    this.keyManager = options.keyManager ?? null;
    this.correlationMap = options.correlationMap ?? new KeyCorrelationMap();
  }

  public async start(spawn: SpawnFunction): Promise<void> {
    if (this.cleanupAbortController) {
      return;
    }

    const controller = new AbortController();
    this.cleanupAbortController = controller;
    const result = spawn(
      async () => {
        await this.correlationMap.runCleanup({ signal: controller.signal });
      },
      { name: 'key-corr-cleanup' }
    );

    this.cleanupTask = isPromise(result) ? result : null;
    logger.debug('key_frame_handler_started');
  }

  public async stop(): Promise<void> {
    if (!this.cleanupAbortController) {
      return;
    }

    this.cleanupAbortController.abort();
    const pending = this.cleanupTask;
    this.cleanupAbortController = null;
    this.cleanupTask = null;

    if (isPromise(pending)) {
      try {
        await pending;
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          logger.warning('key_corr_cleanup_stop_error', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.debug('key_frame_handler_stopped');
  }

  public async acceptKeyAnnounce(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const normalizedContext = this.normalizeContext(
      context,
      'KeyAnnounce handling requires delivery context with originType'
    );

    const frame = envelope.frame as KeyAnnounceFrame | undefined;
    if (!frame || frame.type !== 'KeyAnnounce') {
      logger.warning('unexpected_frame_type_for_key_announce', {
        envp_id: envelope.id,
        frame_type: frame?.type,
      });
      return;
    }

    if (typeof envelope.corrId === 'string') {
      const targetRoute = this.correlationMap.pop(envelope.corrId);
      if (targetRoute) {
        logger.debug('routing_key_announce_to_original_requester', {
          target_route: targetRoute,
        });

        const envelopeFactory = this.routingNode.envelopeFactory;
        const routedOptions: Parameters<
          typeof envelopeFactory.createEnvelope
        >[0] = {
          frame,
          corrId: envelope.corrId,
        };
        if (envelope.traceId) {
          routedOptions.traceId = envelope.traceId;
        }
        if (envelope.flowId) {
          routedOptions.flowId = envelope.flowId;
        }
        if (envelope.replyTo) {
          routedOptions.replyTo = envelope.replyTo;
        }

        const routedEnvelope = envelopeFactory.createEnvelope(routedOptions);

        if (!this.routingNode.forwardToRoute) {
          throw new Error('Routing node does not support forwardToRoute');
        }

        await this.routingNode.forwardToRoute(
          targetRoute,
          routedEnvelope,
          normalizedContext
        );
        return;
      }
    }

    if (
      !this.isKnownOrigin(
        normalizedContext.originType,
        normalizedContext.fromSystemId ?? null
      )
    ) {
      const origin = normalizedContext.fromSystemId ?? 'unknown';
      throw new Error(
        `Cannot accept key announce from unknown ${normalizedContext.originType?.toLowerCase() ?? 'origin'} system ${origin}`
      );
    }

    await this.acceptKeyAnnounceParent(envelope, normalizedContext);
  }

  public async acceptKeyRequest(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<boolean> {
    const normalizedContext = this.normalizeContext(
      context,
      'KeyRequest handling requires delivery context with originType'
    );

    if (!this.keyManager) {
      throw new Error('KeyManager must be set for KeyRequest handling');
    }

    const frame = envelope.frame as KeyRequestFrame | undefined;
    if (!frame || frame.type !== 'KeyRequest') {
      throw new Error('KeyFrameHandler only handles KeyRequest frames');
    }

    const originSegment = this.getSourceSystemId(normalizedContext);
    if (!originSegment) {
      throw new Error('Missing origin system id for KeyRequest');
    }

    if (frame.address && typeof envelope.corrId === 'string') {
      this.correlationMap.add(envelope.corrId, originSegment);
      logger.debug('stored_key_request_correlation', {
        corr_id: envelope.corrId,
        origin: originSegment,
        address: String(frame.address),
      });
    }

    if (frame.address) {
      const handled = await this.handleKeyRequestByAddress({
        address: frame.address,
        fromSegment: originSegment,
        physicalPath: frame.physicalPath ?? null,
        context: normalizedContext,
        ...(envelope.corrId ? { corrId: envelope.corrId } : {}),
        originalEnvelope: envelope,
      });
      return handled;
    }

    if (frame.kid) {
      await this.handleKeyRequestById({
        frame,
        envelope,
        context: normalizedContext,
        originSegment,
      });
      return true;
    }

    throw new Error('KeyRequest must include either kid or address');
  }

  private async handleKeyRequestById(options: {
    frame: KeyRequestFrame;
    envelope: FameEnvelope;
    context: FameDeliveryContext;
    originSegment: string;
  }): Promise<void> {
    if (!this.keyManager) {
      throw new Error('KeyManager must be set for KeyRequest handling');
    }

    const { frame, envelope, context, originSegment } = options;

    if (frame.physicalPath) {
      try {
        const keys = toRecordKeys(
          await this.keyManager.getKeysForPath(frame.physicalPath)
        );
        const encryptionKeys = keys.filter((key) => key.use === 'enc');
        if (encryptionKeys.length > 0) {
          this.markStickiness(context, envelope.sid ?? undefined);
        }
      } catch (error) {
        logger.trace('key_lookup_for_physical_path_failed', {
          physical_path: frame.physicalPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const request: Parameters<KeyManager['handleKeyRequest']>[0] = {
      kid: frame.kid!,
      fromSegment: originSegment,
      origin: context.originType!,
    };
    if (frame.physicalPath) {
      request.physicalPath = frame.physicalPath;
    }
    if (envelope.corrId) {
      request.correlationId = envelope.corrId;
    }
    if (envelope.sid) {
      request.originalClientSid = envelope.sid;
    }

    await this.keyManager.handleKeyRequest(request);
  }

  private async handleKeyRequestByAddress(options: {
    address: FameAddress | string;
    fromSegment: string;
    physicalPath: string | null;
    context: FameDeliveryContext;
    corrId?: string;
    originalEnvelope?: FameEnvelope;
  }): Promise<boolean> {
    if (!this.keyManager) {
      throw new Error('KeyManager must be set for KeyRequest handling');
    }

    const {
      address,
      fromSegment,
      physicalPath,
      context,
      corrId,
      originalEnvelope,
    } = options;
    const addressStr = String(address);

    logger.trace('handling_key_request_by_address', {
      address: addressStr,
      corr_id: corrId,
    });

    const routeInfo = this.getAddressRouteInfo(address);
    if (routeInfo?.segment) {
      logger.debug('key_request_needs_routing', {
        address: addressStr,
        segment: routeInfo.segment,
        corr_id: corrId,
      });
      return false;
    }

    const localBinding = this.bindingManager.getBinding(addressStr);
    if (localBinding) {
      const localPath = this.routingNode.physicalPath;
      try {
        const keys = toRecordKeys(
          await this.keyManager.getKeysForPath(localPath)
        );
        const encryptionKeys = keys.filter((key) => key.use === 'enc');
        if (encryptionKeys.length > 0) {
          const selected = encryptionKeys[0];
          const kid =
            typeof selected.kid === 'string' ? selected.kid : undefined;
          if (kid) {
            this.markStickiness(context, originalEnvelope?.sid ?? fromSegment);

            await this.sendKeyRequest({
              kid,
              fromSegment,
              originType: context.originType!,
              physicalPath: localPath,
              ...(corrId ? { corrId } : {}),
              originalSid: originalEnvelope?.sid,
            });
            return true;
          }
        }
      } catch (error) {
        logger.trace('key_lookup_for_local_binding_failed', {
          path: localPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (routeInfo?.encryptionKeyId) {
      try {
        this.markStickiness(context, originalEnvelope?.sid ?? fromSegment);
        await this.sendKeyRequest({
          kid: routeInfo.encryptionKeyId,
          fromSegment,
          originType: context.originType!,
          physicalPath: routeInfo.physicalPath ?? physicalPath ?? undefined,
          ...(corrId ? { corrId } : {}),
          originalSid: originalEnvelope?.sid,
        });
        return true;
      } catch (error) {
        logger.trace('key_lookup_by_encryption_key_id_failed', {
          address: addressStr,
          key_id: routeInfo.encryptionKeyId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (routeInfo?.physicalPath) {
      try {
        const keys = toRecordKeys(
          await this.keyManager.getKeysForPath(routeInfo.physicalPath)
        );
        const encryptionKeys = keys.filter((key) => key.use === 'enc');
        if (encryptionKeys.length > 0) {
          const kid = encryptionKeys[0]?.kid;
          if (kid && typeof kid === 'string') {
            this.markStickiness(context, originalEnvelope?.sid ?? fromSegment);
            await this.sendKeyRequest({
              kid,
              fromSegment,
              originType: context.originType!,
              physicalPath: routeInfo.physicalPath,
              ...(corrId ? { corrId } : {}),
              originalSid: originalEnvelope?.sid,
            });
            return true;
          }
        }
      } catch (error) {
        logger.trace('key_lookup_by_physical_path_failed', {
          address: addressStr,
          path: routeInfo.physicalPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const extractedPath = this.extractPhysicalPathFromAddress(addressStr);
    if (extractedPath) {
      try {
        const keys = toRecordKeys(
          await this.keyManager.getKeysForPath(extractedPath)
        );
        const encryptionKeys = keys.filter((key) => key.use === 'enc');
        if (encryptionKeys.length > 0) {
          const kid = encryptionKeys[0]?.kid;
          if (kid && typeof kid === 'string') {
            this.markStickiness(context, originalEnvelope?.sid ?? fromSegment);
            await this.sendKeyRequest({
              kid,
              fromSegment,
              originType: context.originType!,
              physicalPath: extractedPath,
              ...(corrId ? { corrId } : {}),
              originalSid: originalEnvelope?.sid,
            });
            return true;
          }
        }
      } catch (error) {
        logger.trace('key_lookup_by_extracted_path_failed', {
          address: addressStr,
          path: extractedPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.trace('delegating_key_request_to_routing_pipeline', {
      address: addressStr,
      corr_id: corrId,
    });
    return false;
  }

  private normalizeContext(
    context: FameDeliveryContext | undefined,
    errorMessage: string
  ): FameDeliveryContext & { originType: DeliveryOriginType } {
    if (!context) {
      throw new Error(errorMessage);
    }

    const rawOrigin =
      (context as any).originType ?? (context as any).origin_type ?? null;
    const originType = resolveOriginType(rawOrigin);
    if (!originType) {
      throw new Error(errorMessage);
    }

    context.originType = originType;
    (context as any).origin_type = originType;

    const fromSystemId =
      (context as any).fromSystemId ??
      (context as any).from_system_id ??
      undefined;
    if (fromSystemId !== undefined) {
      context.fromSystemId = fromSystemId ?? undefined;
      (context as any).from_system_id = fromSystemId ?? undefined;
    }

    const expectedResponse =
      (context as any).expectedResponseType ??
      (context as any).expected_response_type ??
      undefined;
    if (expectedResponse !== undefined) {
      context.expectedResponseType = expectedResponse;
      (context as any).expected_response_type = expectedResponse;
    }

    return context as FameDeliveryContext & { originType: DeliveryOriginType };
  }

  private markStickiness(
    context: FameDeliveryContext,
    stickySid: string | null | undefined
  ): void {
    context.stickinessRequired = true;
    updateStickinessAliases(context, stickySid ?? undefined);
  }

  private getAddressRouteInfo(
    address: FameAddress | string
  ): AddressRouteInfo | null {
    const key = String(address);
    const downstream = toRouteMap(
      getRouteManagerField<
        Map<string, AddressRouteInfo> | Record<string, AddressRouteInfo>
      >(this.routeManager, [
        '_downstream_addresses_routes',
        'downstream_addresses_routes',
      ])
    );
    if (downstream.has(key)) {
      return downstream.get(key) ?? null;
    }

    const peerRoutes = toStringMap(
      getRouteManagerField<Map<string, string> | Record<string, string>>(
        this.routeManager,
        ['_peer_addresses_routes', 'peer_addresses_routes']
      )
    );
    if (peerRoutes.has(key)) {
      const segment = peerRoutes.get(key);
      if (segment) {
        return { segment };
      }
    }

    return null;
  }

  private async sendKeyRequest(options: {
    kid: string;
    fromSegment: string;
    originType: DeliveryOriginType;
    physicalPath?: string | null | undefined;
    corrId?: string;
    originalSid?: string | null | undefined;
  }): Promise<void> {
    if (!this.keyManager) {
      throw new Error('KeyManager must be set for KeyRequest handling');
    }

    const request: Parameters<KeyManager['handleKeyRequest']>[0] = {
      kid: options.kid,
      fromSegment: options.fromSegment,
      origin: options.originType,
    };

    if (options.physicalPath) {
      request.physicalPath = options.physicalPath;
    }

    if (options.corrId) {
      request.correlationId = options.corrId;
    }

    if (options.originalSid != null) {
      request.originalClientSid = options.originalSid;
    }

    await this.keyManager.handleKeyRequest(request);
  }

  private extractPhysicalPathFromAddress(address: string): string | null {
    const atIndex = address.indexOf('@');
    if (atIndex < 0) {
      return null;
    }
    const possiblePath = address.slice(atIndex + 1);
    if (possiblePath.startsWith('/')) {
      return possiblePath;
    }
    return null;
  }

  private isKnownOrigin(
    origin: DeliveryOriginType,
    systemId: string | null
  ): boolean {
    if (!systemId) {
      return false;
    }

    if (origin === DeliveryOriginType.DOWNSTREAM) {
      const container = getRouteManagerField<
        Map<string, unknown> | Record<string, unknown>
      >(this.routeManager, ['downstreamRoutes', 'downstream_routes']);
      return this.hasRoute(container, systemId);
    }

    if (origin === DeliveryOriginType.PEER) {
      const container = getRouteManagerField<
        Map<string, unknown> | Record<string, unknown>
      >(this.routeManager, ['_peer_routes', 'peer_routes']);
      return this.hasRoute(container, systemId);
    }

    return true;
  }

  private hasRoute(
    container: Map<string, unknown> | Record<string, unknown> | undefined,
    key: string
  ): boolean {
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

  private getSourceSystemId(context: FameDeliveryContext): string | null {
    const fromSystemId =
      context.fromSystemId ?? (context as any).from_system_id ?? null;
    if (fromSystemId != null) {
      context.fromSystemId = fromSystemId;
      (context as any).from_system_id = fromSystemId;
    }
    return fromSystemId ?? null;
  }
}
