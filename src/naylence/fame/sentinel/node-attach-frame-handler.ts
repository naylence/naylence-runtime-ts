import {
  DeliveryOriginType,
  FameResponseType,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  NodeAttachAckFrame,
  NodeAttachFrame,
  type Stickiness,
} from "naylence-core";

import type { RoutingNodeLike } from "../node/routing-node-like.js";
import type { RouteManager, PendingRouteEntry } from "./route-manager.js";
import {
  AttachmentKeyValidator,
  KeyValidationError,
} from "../security/keys/attachment-key-validator.js";
import type { LoadBalancerStickinessManager } from "../stickiness/load-balancer-stickiness-manager.js";
import { TaskSpawner } from "../util/task-spawner.js";
import { delay } from "../util/task-utils.js";
import { getLogger } from "../util/logging.js";
import type { ConnectorConfig } from "../connector/connector-config.js";

const logger = getLogger("node-attach-frame-handler");

const DOWNSTREAM_ORIGINS = new Set<DeliveryOriginType>([
  DeliveryOriginType.DOWNSTREAM,
  DeliveryOriginType.PEER,
]);

type RoutingNodeWithExtras = RoutingNodeLike & {
  readonly routingEpoch?: string | null | undefined;
  readonly securityManager?: { getShareableKeys(): unknown } | null;
};

function buildAssignedPath(basePath: string, systemId: string): string {
  if (!basePath || basePath === "/") {
    return `/${systemId}`;
  }
  return `${basePath.replace(/\/$/, "")}/${systemId}`;
}

export interface NodeAttachFrameHandlerOptions {
  routingNode: RoutingNodeLike;
  routeManager: RouteManager;
  attachmentKeyValidator?: AttachmentKeyValidator | null;
  stickinessManager?: LoadBalancerStickinessManager | null;
  maxTtlSec?: number | null;
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
    logger.debug("handling_node_attach_request");

    if (!context) {
      throw new Error("missing FameDeliveryContext");
    }

    const frame = envelope.frame as NodeAttachFrame | undefined;
    if (!frame || frame.type !== "NodeAttach") {
      throw new Error(
        `Invalid envelope frame. Expected: NodeAttachFrame, actual: ${frame?.type ?? "unknown"}`
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
      throw new Error("Missing pending config metadata");
    }

    const pendingRoute = this.takePendingRoute(attachedSystemId);
    if (!pendingRoute) {
      throw new Error(`No pending connector for system_id: ${attachedSystemId}`);
    }

    const { connector, attached, buffer } = pendingRoute;
    pendingRoute.cancelAttachTimeout?.();
    if (connector !== context.fromConnector) {
      throw new Error("Connector in context does not match pending connector");
    }

    const validationResult = await this.validateAttachmentKeys(
      frame,
      envelope,
      connector,
      context,
      attachedSystemId
    );

    if (validationResult === "rejected") {
      return;
    }

    let attachExpiresAt = this.computeAttachExpiry(validationResult?.earliestKeyExpiry ?? null);

    attached.set();

    const deliveryContext: FameDeliveryContext = {
      fromConnector: connector,
      fromSystemId: attachedSystemId,
      originType: frame.originType,
      expectedResponseType: FameResponseType.NONE,
      security: context.security,
    };

    for (const pendingEnvelope of buffer) {
      await this.routingNode.deliver(pendingEnvelope, deliveryContext);
    }
    buffer.length = 0;

    let assignedPath: string;
    let oldAssignedPath: string | null = null;
    let isRebind = false;

    if (frame.originType === DeliveryOriginType.DOWNSTREAM) {
      const hasExistingRoute = this.routeManager.downstreamRoutes.has(attachedSystemId);
      if (hasExistingRoute) {
        isRebind = true;
        oldAssignedPath = buildAssignedPath(this.routingNode.physicalPath, attachedSystemId);
        await this.routeManager.unregisterDownstreamRoute(attachedSystemId).catch((error) => {
          logger.warning("failed_to_unregister_downstream_route_before_rebind", {
            system_id: attachedSystemId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      assignedPath =
        frame.assignedPath ?? buildAssignedPath(this.routingNode.physicalPath, attachedSystemId);
    } else if (frame.originType === DeliveryOriginType.PEER) {
      const hasExistingRoute = this.routeManager._peer_routes.has(attachedSystemId);
      if (hasExistingRoute) {
        isRebind = true;
        oldAssignedPath = frame.assignedPath ?? `/${attachedSystemId}`;
        await this.routeManager.unregisterPeerRoute(attachedSystemId).catch((error) => {
          logger.warning("failed_to_unregister_peer_route_before_rebind", {
            system_id: attachedSystemId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      assignedPath = frame.assignedPath ?? `/${attachedSystemId}`;
    } else {
      throw new Error("Unsupported origin type for node attach");
    }

    await this.routingNode.dispatchEvent("onChildAttach", {
      childSystemId: attachedSystemId,
      childKeys: frame.keys,
      nodeLike: this.routingNode,
      originType: frame.originType,
      assignedPath,
      oldAssignedPath: oldAssignedPath ?? undefined,
      isRebind,
    });

    if (frame.originType === DeliveryOriginType.DOWNSTREAM) {
      await this.routeManager.registerDownstreamRoute(attachedSystemId, connector);
    } else {
      await this.routeManager.registerPeerRoute(attachedSystemId, connector);
    }

    const negotiatedStickiness = this.negotiateStickiness(frame.stickiness);

    const ackEnvelope = this.createNodeAttachAckEnvelope({
      ok: true,
      originalEnvId: envelope.id ?? "unknown",
      assignedPath,
      expiresAt: attachExpiresAt,
      ...(envelope.corrId ? { correlationId: envelope.corrId } : {}),
      ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
      ...(negotiatedStickiness !== null && negotiatedStickiness !== undefined
        ? { stickiness: negotiatedStickiness }
        : {}),
    });

    logger.debug("sending_node_attach_ack", { env_id: ackEnvelope.id ?? "unknown" });

    await this.sendAndNotify(connector, ackEnvelope, attachedSystemId, context);

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

  private negotiateStickiness(stickiness: Stickiness | undefined | null): Stickiness | null {
    if (!this.stickinessManager) {
      return null;
    }

    try {
      return this.stickinessManager.negotiate(stickiness);
    } catch (error) {
      logger.debug("stickiness_negotiate_skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private computeAttachExpiry(earliestKeyExpiry: Date | null): Date | null {
    let attachExpiresAt: Date | null = null;

    if (typeof this.maxTtlSec === "number" && Number.isFinite(this.maxTtlSec)) {
      attachExpiresAt = new Date(Date.now() + this.maxTtlSec * 1000);
    }

    if (!earliestKeyExpiry) {
      return attachExpiresAt;
    }

    if (!attachExpiresAt || earliestKeyExpiry < attachExpiresAt) {
      if (attachExpiresAt) {
        logger.warning("attachment_ttl_limited_by_key_expiry", {
          limited_attach_expires_at: earliestKeyExpiry.toISOString(),
          original_attach_expires_at: attachExpiresAt.toISOString(),
        });
      } else {
        logger.debug("attachment_ttl_set_by_key_expiry", {
          attach_expires_at: earliestKeyExpiry.toISOString(),
          reason: "no_max_ttl_configured",
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
  ): Promise<{ earliestKeyExpiry: Date | null } | "rejected"> {
    if (!this.attachmentKeyValidator) {
      logger.debug("child_key_validation_skipped", {
        child_id: systemId,
        reason: "no_validator",
      });
      return { earliestKeyExpiry: null };
    }

    try {
      const keyInfos = await this.attachmentKeyValidator.validateKeys(frame.keys ?? []);
      let earliestKeyExpiry: Date | null = null;

      for (const info of keyInfos) {
        if (info.expiresAt && (!earliestKeyExpiry || info.expiresAt < earliestKeyExpiry)) {
          earliestKeyExpiry = info.expiresAt;
        }
      }

      if (keyInfos.length > 0) {
        logger.debug("node_attach_key_validation_passed", {
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
          originalEnvId: envelope.id ?? "unknown",
          ...(envelope.corrId ? { correlationId: envelope.corrId } : {}),
          ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
          reason: `Certificate validation failed: ${error.message}`,
        });

        await this.sendAndNotify(connector, rejectionAck, systemId, context).catch((sendError) => {
          logger.error("failed_sending_negative_attach_ack", {
            error: sendError instanceof Error ? sendError.message : String(sendError),
          });
        });

        logger.error("node_attach_key_validation_failed", {
          system_id: systemId,
          instance_id: frame.instanceId,
          correlation_id: envelope.corrId,
          error_code: error.code,
          error_message: error.message,
          kid: error.kid,
          action: "rejecting_attachment",
        });

        this.spawn(() => this.closeConnectionAfterDelay(connector, 100), {
          name: `close-invalid-key-connection-${systemId}`,
        });

        return "rejected";
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
      type: "NodeAttachAck",
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

    const shareableKeys = this.routingNode.securityManager?.getShareableKeys?.();
    if (shareableKeys !== undefined && shareableKeys !== null) {
      if (Array.isArray(shareableKeys)) {
        frame.keys = shareableKeys as Array<Record<string, unknown>>;
      } else {
        frame.keys = [shareableKeys as Record<string, unknown>];
      }
    }

    const envelopeOptions: Parameters<RoutingNodeLike["envelopeFactory"]["createEnvelope"]>[0] = {
      frame,
    };

    if (options.correlationId) {
      envelopeOptions.corrId = options.correlationId;
    }

    if (options.traceId) {
      envelopeOptions.traceId = options.traceId;
    }

    return this.routingNode.envelopeFactory.createEnvelope(envelopeOptions);
  }

  private async closeConnectionAfterDelay(
    connector: FameConnector,
    delaySeconds: number
  ): Promise<void> {
    try {
      await delay(delaySeconds * 1000);
      await connector.close(1008, "attach-unauthorized");
      logger.debug("closed_unauthorized_connection");
    } catch (error) {
      logger.error("failed_to_close_unauthorized_connection", {
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
        "onForwardToRoute",
        this.routingNode,
        forwardRoute,
        envelope,
        context
      );

      if (!processed) {
        throw new Error("Envelope was blocked by onForwardToRoute event");
      }

      await connector.send(processed);

      await this.routingNode
        .dispatchEnvelopeEvent(
          "onForwardToRouteComplete",
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
          "onForwardToRouteComplete",
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
}
