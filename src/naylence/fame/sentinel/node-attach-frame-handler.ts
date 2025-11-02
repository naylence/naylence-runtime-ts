import {
  DeliveryOriginType,
  FameResponseType,
  type CreateFameEnvelopeOptions,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  NodeAttachAckFrame,
  NodeAttachFrame,
  type Stickiness,
} from '@naylence/core';

import type { RoutingNodeLike } from '../node/routing-node-like.js';
import type { RouteManager, PendingRouteEntry } from './route-manager.js';
import {
  AttachmentKeyValidator,
  KeyValidationError,
} from '../security/keys/attachment-key-validator.js';
import type { LoadBalancerStickinessManager } from '../stickiness/load-balancer-stickiness-manager.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { delay } from '../util/task-utils.js';
import { getLogger } from '../util/logging.js';
import type { ConnectorConfig } from '../connector/connector-config.js';

const logger = getLogger('naylence.fame.sentinel.node_attach_frame_handler');

const DOWNSTREAM_ORIGINS = new Set<DeliveryOriginType>([
  DeliveryOriginType.DOWNSTREAM,
  DeliveryOriginType.PEER,
]);

type NodeAttachFrameLike = NodeAttachFrame & Record<string, unknown>;

type RoutingNodeWithExtras = RoutingNodeLike & {
  readonly routingEpoch?: string | null | undefined;
  readonly securityManager?: { getShareableKeys(): unknown } | null;
};

function buildAssignedPath(basePath: string, systemId: string): string {
  if (!basePath || basePath === '/') {
    return `/${systemId}`;
  }
  return `${basePath.replace(/\/$/, '')}/${systemId}`;
}

export interface NodeAttachFrameHandlerOptions {
  routingNode: RoutingNodeLike;
  routeManager: RouteManager;
  attachmentKeyValidator?: AttachmentKeyValidator | null;
  stickinessManager?: LoadBalancerStickinessManager | null;
  maxTtlSec?: number | null;
}

function resolveOriginType(raw: unknown): DeliveryOriginType | null {
  if (raw == null) {
    return null;
  }

  const values = Object.values(DeliveryOriginType) as DeliveryOriginType[];
  if (values.includes(raw as DeliveryOriginType)) {
    return raw as DeliveryOriginType;
  }

  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    const directMatch = values.find(
      (entry) => entry.toLowerCase() === lower
    );
    if (directMatch) {
      return directMatch;
    }

    const enumMatch = Object.entries(DeliveryOriginType).find(
      ([key]) => key.toLowerCase() === lower
    );
    if (enumMatch) {
      return enumMatch[1] as DeliveryOriginType;
    }
  }

  return null;
}

function normalizeStickinessAliases(
  stickiness: Stickiness | Record<string, unknown> | null | undefined
): Stickiness | null | undefined {
  if (!stickiness) {
    return stickiness ?? null;
  }

  const record = stickiness as Record<string, unknown>;
  const clone: Record<string, unknown> = { ...record };

  if (record.supportedModes === undefined && record['supported_modes']) {
    clone.supportedModes = record['supported_modes'];
  }
  if (record['supported_modes'] === undefined && record.supportedModes) {
    clone['supported_modes'] = record.supportedModes;
  }
  if (record.preferredMode === undefined && record['preferred_mode']) {
    clone.preferredMode = record['preferred_mode'];
  }
  if (record['preferred_mode'] === undefined && record.preferredMode) {
    clone['preferred_mode'] = record.preferredMode;
  }
  if (record.maxAge === undefined && record['max_age']) {
    clone.maxAge = record['max_age'];
  }
  if (record['max_age'] === undefined && record.maxAge) {
    clone['max_age'] = record.maxAge;
  }

  return clone as Stickiness;
}

function mirrorAckFrameAliases(frame: NodeAttachAckFrame): void {
  const mutable = frame as NodeAttachAckFrame & Record<string, unknown>;
  mutable.ref_id = frame.refId;
  mutable.target_system_id = frame.targetSystemId;
  mutable.target_physical_path = frame.targetPhysicalPath;
  if (frame.routingEpoch !== undefined) {
    mutable.routing_epoch = frame.routingEpoch;
  }
  if (frame.assignedPath !== undefined) {
    mutable.assigned_path = frame.assignedPath;
  }
  if (frame.expiresAt !== undefined) {
    mutable.expires_at = frame.expiresAt;
  }
  if (frame.reason !== undefined) {
    mutable.reason = frame.reason;
  }
  if (frame.stickiness !== undefined) {
    const normalized = normalizeStickinessAliases(frame.stickiness);
    if (normalized) {
      frame.stickiness = normalized;
      mutable.stickiness = normalized;
    }
  }
}

export class NodeAttachFrameHandler extends TaskSpawner {
  private readonly routingNode: RoutingNodeWithExtras;
  private readonly routeManager: RouteManager;
  private readonly attachmentKeyValidator: AttachmentKeyValidator | null;
  private readonly stickinessManager: LoadBalancerStickinessManager | null;
  private readonly maxTtlSec: number | null;

  constructor(options: NodeAttachFrameHandlerOptions) {
    super();
    this.routingNode = options.routingNode as RoutingNodeWithExtras;
    this.routeManager = options.routeManager;
    this.attachmentKeyValidator = options.attachmentKeyValidator ?? null;
    this.stickinessManager = options.stickinessManager ?? null;
    this.maxTtlSec = options.maxTtlSec ?? null;
  }

  public async acceptNodeAttach(
    envelope: FameEnvelope,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    logger.debug('handling_node_attach_request');

    const normalizedContext = this.normalizeContext(context);

    const frame = this.normalizeNodeAttachFrame(envelope.frame);
    if (frame.type !== 'NodeAttach') {
      throw new Error(
        `Invalid envelope frame. Expected: NodeAttachFrame, actual: ${frame?.type ?? 'unknown'}`
      );
    }

    if (!DOWNSTREAM_ORIGINS.has(frame.originType)) {
      throw new Error(
        `Invalid attach frame origin type. Expected: DOWNSTREAM or PEER, actual: ${frame.originType}`
      );
    }

    const attachedSystemId = frame.systemId;
    const connectorConfig = this.takePendingRouteMetadata(attachedSystemId);
    if (!connectorConfig) {
      throw new Error('Missing pending config metadata');
    }

    const pendingRoute = this.takePendingRoute(attachedSystemId);
    if (!pendingRoute) {
      throw new Error(
        `No pending connector for system_id: ${attachedSystemId}`
      );
    }

    const { connector, attached, buffer } = pendingRoute;
    pendingRoute.cancelAttachTimeout?.();
      if (connector !== normalizedContext.fromConnector) {
      throw new Error('Connector in context does not match pending connector');
    }

    const validationResult = await this.validateAttachmentKeys(
      frame,
      envelope,
      connector,
        normalizedContext,
      attachedSystemId
    );

    if (validationResult === 'rejected') {
      return;
    }

    let attachExpiresAt = this.computeAttachExpiry(
      validationResult?.earliestKeyExpiry ?? null
    );

    attached.set();

    const deliveryContext: FameDeliveryContext = {
      fromConnector: connector,
      fromSystemId: attachedSystemId,
      originType: frame.originType,
      expectedResponseType: FameResponseType.NONE,
      security: normalizedContext.security,
    };

    for (const pendingEnvelope of buffer) {
      await this.routingNode.deliver(pendingEnvelope, deliveryContext);
    }
    buffer.length = 0;

    let assignedPath: string;
    let oldAssignedPath: string | null = null;
    let isRebind = false;

    if (frame.originType === DeliveryOriginType.DOWNSTREAM) {
      const hasExistingRoute =
        this.routeManager.downstreamRoutes.has(attachedSystemId);
      logger.debug('checking_for_existing_route', {
        system_id: attachedSystemId,
        has_existing: hasExistingRoute,
        existing_routes: Array.from(this.routeManager.downstreamRoutes.keys()),
      });
      if (hasExistingRoute) {
        isRebind = true;
        logger.warning('rebinding_existing_downstream_route', {
          system_id: attachedSystemId,
        });
        oldAssignedPath = buildAssignedPath(
          this.routingNode.physicalPath,
          attachedSystemId
        );

        // Before unregistering the route, collect addresses that will become orphaned
        // so we can clean up their associated secure channels
        const orphanedAddresses: string[] = [];
        for (const [
          address,
          info,
        ] of this.routeManager._downstream_addresses_routes.entries()) {
          if (info.segment === attachedSystemId) {
            orphanedAddresses.push(address);
          }
        }

        await this.routeManager
          .unregisterDownstreamRoute(attachedSystemId, {
            reason: 'rebind_downstream_route',
            delayMs: 0, // Stop old connector immediately during rebind to prevent message loss
            meta: { systemId: attachedSystemId },
          })
          .catch((error: unknown) => {
            logger.warning(
              'failed_to_unregister_downstream_route_before_rebind',
              {
                system_id: attachedSystemId,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          });

        // Clean up secure channels for orphaned addresses to prevent stale channel reuse
        if (orphanedAddresses.length > 0) {
          try {
            // Access encryption manager - CompositeEncryptionManager exposes channel cleanup methods
            const securityMgr = this.routingNode.securityManager as any;
            const encryptionMgr = securityMgr?.encryption;

            // CompositeEncryptionManager provides clearChannelCacheForDestination and removeChannelsForDestination
            if (
              typeof encryptionMgr?.clearChannelCacheForDestination ===
              'function'
            ) {
              for (const address of orphanedAddresses) {
                encryptionMgr.clearChannelCacheForDestination(address);
              }
              logger.debug('cleared_channel_cache_for_rebind', {
                system_id: attachedSystemId,
                addresses: orphanedAddresses,
              });
            }

            if (
              typeof encryptionMgr?.removeChannelsForDestination === 'function'
            ) {
              let totalRemoved = 0;
              for (const address of orphanedAddresses) {
                totalRemoved +=
                  encryptionMgr.removeChannelsForDestination(address);
              }
              if (totalRemoved > 0) {
                logger.debug('removed_channel_states_for_rebind', {
                  system_id: attachedSystemId,
                  channels_removed: totalRemoved,
                });
              }
            }
          } catch (error) {
            logger.warning('failed_to_cleanup_channels_for_rebind', {
              system_id: attachedSystemId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      assignedPath =
        frame.assignedPath ??
        buildAssignedPath(this.routingNode.physicalPath, attachedSystemId);
    } else if (frame.originType === DeliveryOriginType.PEER) {
      const hasExistingRoute =
        this.routeManager._peer_routes.has(attachedSystemId);
      if (hasExistingRoute) {
        isRebind = true;
        oldAssignedPath = frame.assignedPath ?? `/${attachedSystemId}`;
        await this.routeManager
          .unregisterPeerRoute(attachedSystemId, {
            reason: 'rebind_peer_route',
            delayMs: 0, // Stop old connector immediately during rebind to prevent message loss
            meta: { systemId: attachedSystemId },
          })
          .catch((error: unknown) => {
            logger.warning('failed_to_unregister_peer_route_before_rebind', {
              system_id: attachedSystemId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      assignedPath = frame.assignedPath ?? `/${attachedSystemId}`;
    } else {
      throw new Error('Unsupported origin type for node attach');
    }

    await this.routingNode.dispatchEvent('onChildAttach', {
      childSystemId: attachedSystemId,
      childKeys: frame.keys,
      nodeLike: this.routingNode,
      originType: frame.originType,
      assignedPath,
      oldAssignedPath: oldAssignedPath ?? undefined,
      isRebind,
    });

    if (frame.originType === DeliveryOriginType.DOWNSTREAM) {
      await this.routeManager.registerDownstreamRoute(
        attachedSystemId,
        connector
      );
    } else {
      await this.routeManager.registerPeerRoute(attachedSystemId, connector);
    }

    const negotiatedStickiness = this.negotiateStickiness(frame.stickiness);

    const ackEnvelope = this.createNodeAttachAckEnvelope({
      ok: true,
      originalEnvId: envelope.id ?? 'unknown',
      assignedPath,
      expiresAt: attachExpiresAt,
      ...(envelope.corrId ? { correlationId: envelope.corrId } : {}),
      ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
      ...(negotiatedStickiness !== null && negotiatedStickiness !== undefined
        ? { stickiness: negotiatedStickiness }
        : {}),
    });

    logger.debug('sending_node_attach_ack', {
      env_id: ackEnvelope.id ?? 'unknown',
    });

    await this.sendAndNotify(
      connector,
      ackEnvelope,
      attachedSystemId,
      normalizedContext
    );

    if (connectorConfig.durable) {
      const routeStore =
        frame.originType === DeliveryOriginType.DOWNSTREAM
          ? this.routeManager._downstream_route_store
          : this.routeManager._peer_route_store;

      const routeEntry = {
        systemId: attachedSystemId,
        instanceId: frame.instanceId,
        assignedPath,
        connectorConfig,
        durable: true,
        callbackGrants: frame.callbackGrants ?? null,
        attachExpiresAt: attachExpiresAt ?? null,
      };

      await routeStore.set(attachedSystemId, routeEntry);
    }
  }

  private takePendingRouteMetadata(systemId: string): ConnectorConfig | null {
    const map = this.routeManager._pending_route_metadata;
    const value = map.get(systemId) ?? null;
    if (value) {
      map.delete(systemId);
    }
    return value;
  }

  private takePendingRoute(systemId: string): PendingRouteEntry | null {
    const map = this.routeManager._pending_routes;
    if (!map) {
      return null;
    }

    const entry = map.get(systemId) ?? null;
    if (entry) {
      map.delete(systemId);
    }
    return entry;
  }

  private negotiateStickiness(
    stickiness: Stickiness | undefined | null
  ): Stickiness | null {
    if (!this.stickinessManager) {
      return null;
    }

    try {
      return this.stickinessManager.negotiate(stickiness);
    } catch (error) {
      logger.debug('stickiness_negotiate_skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private computeAttachExpiry(earliestKeyExpiry: Date | null): Date | null {
    let attachExpiresAt: Date | null = null;

    if (typeof this.maxTtlSec === 'number' && Number.isFinite(this.maxTtlSec)) {
      attachExpiresAt = new Date(Date.now() + this.maxTtlSec * 1000);
    }

    if (!earliestKeyExpiry) {
      return attachExpiresAt;
    }

    if (!attachExpiresAt || earliestKeyExpiry < attachExpiresAt) {
      if (attachExpiresAt) {
        logger.warning('attachment_ttl_limited_by_key_expiry', {
          limited_attach_expires_at: earliestKeyExpiry.toISOString(),
          original_attach_expires_at: attachExpiresAt.toISOString(),
        });
      } else {
        logger.debug('attachment_ttl_set_by_key_expiry', {
          attach_expires_at: earliestKeyExpiry.toISOString(),
          reason: 'no_max_ttl_configured',
        });
      }
      return earliestKeyExpiry;
    }

    return attachExpiresAt;
  }

  private async validateAttachmentKeys(
    frame: NodeAttachFrame,
    envelope: FameEnvelope,
    connector: FameConnector,
    context: FameDeliveryContext,
    systemId: string
  ): Promise<{ earliestKeyExpiry: Date | null } | 'rejected'> {
    if (!this.attachmentKeyValidator) {
      logger.debug('child_key_validation_skipped', {
        child_id: systemId,
        reason: 'no_validator',
      });
      return { earliestKeyExpiry: null };
    }

    try {
      const keyInfos = await this.attachmentKeyValidator.validateKeys(
        frame.keys ?? []
      );
      let earliestKeyExpiry: Date | null = null;

      for (const info of keyInfos) {
        if (
          info.expiresAt &&
          (!earliestKeyExpiry || info.expiresAt < earliestKeyExpiry)
        ) {
          earliestKeyExpiry = info.expiresAt;
        }
      }

      if (keyInfos.length > 0) {
        logger.debug('node_attach_key_validation_passed', {
          system_id: systemId,
          instance_id: frame.instanceId,
          correlation_id: envelope.corrId,
          validated_keys: keyInfos.length,
          final_attach_expires_at: earliestKeyExpiry?.toISOString() ?? null,
        });
      }

      return { earliestKeyExpiry };
    } catch (error) {
      if (error instanceof KeyValidationError) {
        const rejectionAck = this.createNodeAttachAckEnvelope({
          ok: false,
          originalEnvId: envelope.id ?? 'unknown',
          ...(envelope.corrId ? { correlationId: envelope.corrId } : {}),
          ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
          reason: `Certificate validation failed: ${error.message}`,
        });

        await this.sendAndNotify(
          connector,
          rejectionAck,
          systemId,
          context
        ).catch((sendError: unknown) => {
          logger.error('failed_sending_negative_attach_ack', {
            error:
              sendError instanceof Error
                ? sendError.message
                : String(sendError),
          });
        });

        logger.error('node_attach_key_validation_failed', {
          system_id: systemId,
          instance_id: frame.instanceId,
          correlation_id: envelope.corrId,
          error_code: error.code,
          error_message: error.message,
          kid: error.kid,
          action: 'rejecting_attachment',
        });

        this.spawn(() => this.closeConnectionAfterDelay(connector, 100), {
          name: `close-invalid-key-connection-${systemId}`,
        });

        return 'rejected';
      }

      throw error;
    }
  }

  private createNodeAttachAckEnvelope(options: {
    ok: boolean;
    originalEnvId: string;
    reason?: string | null;
    expiresAt?: Date | null;
    assignedPath?: string | null;
    correlationId?: string | undefined;
    traceId?: string | undefined;
    stickiness?: Stickiness | null | undefined;
  }): FameEnvelope {
    const frame: NodeAttachAckFrame = {
      type: 'NodeAttachAck',
      ok: options.ok,
      refId: options.originalEnvId,
      targetSystemId: this.routingNode.id,
      targetPhysicalPath: this.routingNode.physicalPath,
      routingEpoch: this.routingNode.routingEpoch ?? undefined,
    };

    if (options.reason) {
      frame.reason = options.reason;
    }

    if (options.expiresAt) {
      frame.expiresAt = options.expiresAt.toISOString();
    }

    if (options.assignedPath) {
      frame.assignedPath = options.assignedPath;
    }

    if (options.stickiness !== undefined && options.stickiness !== null) {
      frame.stickiness = options.stickiness;
    }

    const shareableKeys =
      this.routingNode.securityManager?.getShareableKeys?.();
    if (shareableKeys !== undefined && shareableKeys !== null) {
      if (Array.isArray(shareableKeys)) {
        frame.keys = shareableKeys as Array<Record<string, unknown>>;
      } else {
        frame.keys = [shareableKeys as Record<string, unknown>];
      }
    }

    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
    };

    if (options.correlationId) {
      envelopeOptions.corrId = options.correlationId;
    }

    if (options.traceId) {
      envelopeOptions.traceId = options.traceId;
    }

    const envelope =
      this.routingNode.envelopeFactory.createEnvelope(envelopeOptions);

    if (envelope.frame && envelope.frame.type === 'NodeAttachAck') {
      mirrorAckFrameAliases(envelope.frame as NodeAttachAckFrame);
    }

    return envelope;
  }

  private async closeConnectionAfterDelay(
    connector: FameConnector,
    delaySeconds: number
  ): Promise<void> {
    try {
      await delay(delaySeconds * 1000);
      await connector.close(1008, 'attach-unauthorized');
      logger.debug('closed_unauthorized_connection');
    } catch (error) {
      logger.error('failed_to_close_unauthorized_connection', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendAndNotify(
    connector: FameConnector,
    envelope: FameEnvelope,
    forwardRoute: string,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    let processed: FameEnvelope | null = null;

    try {
      processed = await this.routingNode.dispatchEnvelopeEvent(
        'onForwardToRoute',
        this.routingNode,
        forwardRoute,
        envelope,
        context
      );

      if (!processed) {
        throw new Error('Envelope was blocked by onForwardToRoute event');
      }

      await connector.send(processed);

      await this.routingNode
        .dispatchEnvelopeEvent(
          'onForwardToRouteComplete',
          this.routingNode,
          forwardRoute,
          processed,
          undefined,
          undefined,
          context
        )
        .catch(() => undefined);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.routingNode
        .dispatchEnvelopeEvent(
          'onForwardToRouteComplete',
          this.routingNode,
          forwardRoute,
          processed ?? envelope,
          undefined,
          err,
          context
        )
        .catch(() => undefined);
      throw err;
    }
  }

  private normalizeContext(
    context: FameDeliveryContext | null | undefined
  ): FameDeliveryContext {
    if (!context) {
      throw new Error('missing FameDeliveryContext');
    }

    const mutable = context as FameDeliveryContext & Record<string, unknown>;

    const originCandidate =
      mutable.originType ?? mutable.origin_type ?? null;
    const resolvedOrigin = resolveOriginType(originCandidate);
    if (resolvedOrigin) {
      mutable.originType = resolvedOrigin;
      mutable.origin_type = resolvedOrigin;
    } else if (originCandidate !== null && originCandidate !== undefined) {
      mutable.originType = originCandidate as DeliveryOriginType;
      mutable.origin_type = originCandidate as DeliveryOriginType;
    }

    const fromConnector =
      mutable.fromConnector ?? mutable.from_connector ?? undefined;
    if (fromConnector !== undefined) {
      mutable.fromConnector = fromConnector as FameConnector;
      mutable.from_connector = fromConnector as FameConnector;
    }

    const fromSystemId =
      mutable.fromSystemId ?? mutable.from_system_id ?? undefined;
    if (fromSystemId !== undefined) {
      mutable.fromSystemId = fromSystemId as string;
      mutable.from_system_id = fromSystemId as string;
    }

    const expectedResponse =
      mutable.expectedResponseType ?? mutable.expected_response_type ?? undefined;
    if (expectedResponse !== undefined) {
      mutable.expectedResponseType = expectedResponse;
      mutable.expected_response_type = expectedResponse;
    }

    return mutable;
  }

  private normalizeNodeAttachFrame(
    rawFrame: FameEnvelope['frame'] | undefined
  ): NodeAttachFrame {
    const frame = rawFrame as NodeAttachFrameLike | undefined;
    if (!frame) {
      throw new Error('Invalid envelope frame. Expected: NodeAttachFrame, actual: unknown');
    }

    const rawType = (frame as Record<string, unknown>).type;
    if (typeof rawType === 'string' && rawType !== 'NodeAttach') {
      const lower = rawType.toLowerCase();
      if (lower === 'nodeattach' || lower === 'node_attach') {
        frame.type = 'NodeAttach';
        (frame as Record<string, unknown>).type = 'NodeAttach';
      }
    }

    const originCandidate = frame.originType ?? frame.origin_type ?? null;
    const resolvedOrigin = resolveOriginType(originCandidate);
    if (resolvedOrigin) {
      frame.originType = resolvedOrigin;
      frame.origin_type = resolvedOrigin;
    } else if (originCandidate !== null && originCandidate !== undefined) {
      frame.originType = originCandidate as DeliveryOriginType;
      frame.origin_type = originCandidate as DeliveryOriginType;
    }

    const systemId = frame.systemId ?? frame.system_id;
    if (!systemId || typeof systemId !== 'string') {
      throw new Error('NodeAttach frame missing systemId');
    }
    frame.systemId = systemId;
    frame.system_id = systemId;

    const instanceId = frame.instanceId ?? frame.instance_id ?? null;
    if (instanceId !== null && instanceId !== undefined) {
      frame.instanceId = instanceId as string;
      frame.instance_id = instanceId as string;
    }

    const assignedPath = frame.assignedPath ?? frame.assigned_path ?? null;
    if (assignedPath !== null && assignedPath !== undefined) {
      frame.assignedPath = assignedPath as string;
      frame.assigned_path = assignedPath as string;
    }

    const callbackGrants =
      frame.callbackGrants ?? frame.callback_grants ?? null;
    if (callbackGrants !== null && callbackGrants !== undefined) {
      frame.callbackGrants = callbackGrants as typeof frame.callbackGrants;
      frame.callback_grants = callbackGrants as typeof frame.callbackGrants;
    }

    const rawStickiness = (frame as Record<string, unknown>).stickiness;
    const stickiness = normalizeStickinessAliases(
      rawStickiness as Stickiness | Record<string, unknown> | null | undefined
    );
    if (rawStickiness !== undefined) {
      frame.stickiness = stickiness ?? undefined;
      (frame as Record<string, unknown>).stickiness = stickiness ?? undefined;
    }

    return frame as NodeAttachFrame;
  }
}
