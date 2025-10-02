import {
  ConnectorState,
  DeliveryOriginType,
  FameResponseType,
  createFameEnvelope,
  generateId,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameEnvelopeHandler,
  type FameEnvelopeWith,
  type NodeAttachAckFrame,
  type NodeAttachFrame,
  type NodeWelcomeFrame,
} from "naylence-core";
import { getLogger } from "../../util/logging.js";
import { delay } from "../../util/task-utils.js";
import {
  KeyValidationError,
  type AttachmentKeyValidator,
} from "../../security/keys/attachment-key-validator.js";
import type { ReplicaStickinessManager } from "../../stickiness/replica-stickiness-manager.js";
import type { NodeLike } from "../node-like.js";
import type { AttachInfo, NodeAttachClient } from "./node-attach-client.js";

const logger = getLogger("default-node-attach-client");

const HANDSHAKE_POLL_INTERVAL_MS = 20;

export interface DefaultNodeAttachClientOptions {
  readonly timeoutMs?: number;
  readonly attachmentKeyValidator?: AttachmentKeyValidator;
  readonly replicaStickinessManager?: ReplicaStickinessManager | null;
}

export class DefaultNodeAttachClient implements NodeAttachClient {
  private readonly timeoutMs: number;
  private readonly attachmentKeyValidator: AttachmentKeyValidator | undefined;
  private readonly replicaStickinessManager: ReplicaStickinessManager | null;

  private readonly buffer: FameEnvelope[] = [];
  private inHandshake = false;

  constructor(options: DefaultNodeAttachClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.attachmentKeyValidator = options.attachmentKeyValidator;
    this.replicaStickinessManager = options.replicaStickinessManager ?? null;
  }

  public async attach(
    node: NodeLike,
    originType: DeliveryOriginType,
    connector: FameConnector,
    welcomeFrame: NodeWelcomeFrame,
    finalHandler: FameEnvelopeHandler,
    keys?: Array<Record<string, unknown>>,
    callbackGrants?: Array<Record<string, unknown>>
  ): Promise<AttachInfo> {
    this.inHandshake = true;

    const interimHandler: FameEnvelopeHandler = async (
      envelope: FameEnvelope,
      context?: FameDeliveryContext
    ) => {
      if (this.inHandshake) {
        this.buffer.push(envelope);
        return null;
      }

      return finalHandler(envelope, context);
    };

    await connector.replaceHandler(interimHandler);

    const attachFrame: NodeAttachFrame = {
      type: "NodeAttach",
      originType,
      systemId: welcomeFrame.systemId,
      instanceId: welcomeFrame.instanceId,
    };

    if (welcomeFrame.assignedPath) {
      attachFrame.assignedPath = welcomeFrame.assignedPath;
    }

    if (welcomeFrame.acceptedCapabilities?.length) {
      attachFrame.capabilities = [...welcomeFrame.acceptedCapabilities];
    }

    if (welcomeFrame.acceptedLogicals?.length) {
      attachFrame.acceptedLogicals = [...welcomeFrame.acceptedLogicals];
    }

    if (keys?.length) {
      attachFrame.keys = keys.map((candidate) => ({ ...candidate }));
    }

    if (callbackGrants?.length) {
      attachFrame.callbackGrants = callbackGrants.map((grant) => ({ ...grant }));
    }

    try {
      if (this.replicaStickinessManager) {
        const offer = this.replicaStickinessManager.offer();
        if (offer) {
          attachFrame.stickiness = offer;
        }
      }
    } catch (error) {
      logger.debug("stickiness_offer_skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const corrId = generateId();
    const traceId = generateId();

    const envelope = createFameEnvelope({
      frame: attachFrame,
      corrId,
      traceId,
    });

    const localContext: FameDeliveryContext = {
      originType: DeliveryOriginType.LOCAL,
      expectedResponseType: FameResponseType.NONE,
    };

    let processedEnvelope: FameEnvelope | null = null;

    try {
      processedEnvelope = await node.dispatchEnvelopeEvent(
        "onForwardUpstream",
        node,
        envelope,
        localContext
      );

      if (!processedEnvelope) {
        throw new Error("Envelope was blocked by onForwardUpstream event");
      }

      await connector.send(processedEnvelope);

      await node.dispatchEnvelopeEvent(
        "onForwardUpstreamComplete",
        node,
        processedEnvelope,
        undefined,
        undefined,
        localContext
      );
    } catch (error) {
      const errorObject = error instanceof Error ? error : new Error(String(error));
      await node
        .dispatchEnvelopeEvent(
          "onForwardUpstreamComplete",
          node,
          processedEnvelope ?? envelope,
          undefined,
          errorObject,
          localContext
        )
        .catch(() => undefined);
      throw errorObject;
    }

    const ackEnvelope = await this.awaitAck(connector);
    const ackFrame = ackEnvelope.frame;

    const context: FameDeliveryContext = {
      fromConnector: connector,
      fromSystemId: ackFrame.targetSystemId ?? "unknown",
      originType: DeliveryOriginType.UPSTREAM,
      expectedResponseType: FameResponseType.NONE,
    };

    await node.dispatchEnvelopeEvent("onEnvelopeReceived", node, ackEnvelope, context);

    if (ackEnvelope.corrId !== corrId) {
      throw new Error(
        `Attach rejected, invalid correlation id. Expected: ${corrId}, actual: ${ackEnvelope.corrId ?? "unknown"}`
      );
    }

    if (ackFrame.ok === false) {
      throw new Error(`Attach rejected: ${ackFrame.reason ?? "unknown"}`);
    }

    const parentKeys = ackFrame.keys;
    const parentId = ackFrame.targetSystemId ?? "unknown";

    if (this.attachmentKeyValidator) {
      try {
        const keyInfos = await this.attachmentKeyValidator.validateKeys(parentKeys);

        if (Array.isArray(keyInfos) && keyInfos.length > 0) {
          logger.debug("parent_certificate_validation_passed", {
            parent_id: parentId,
            correlation_id: corrId,
            validated_keys: keyInfos.length,
          });
        }
      } catch (error) {
        if (error instanceof KeyValidationError) {
          logger.error("parent_certificate_validation_failed", {
            parent_id: parentId,
            correlation_id: corrId,
            error_code: error.code,
            error_message: error.message,
            kid: error.kid,
            action: "rejecting_attachment",
          });

          throw new Error(`Parent certificate validation failed: ${error.message}`);
        }

        throw error;
      }
    } else {
      logger.debug("parent_certificate_validation_skipped", {
        parent_id: parentId,
        reason: "no_validator",
      });
    }

    logger.debug("processing_node_attach_ack", {
      parent_id: ackFrame.targetSystemId,
    });

    this.inHandshake = false;
    await connector.replaceHandler(finalHandler);

    while (this.buffer.length > 0) {
      const bufferedEnvelope = this.buffer.shift();
      if (!bufferedEnvelope) {
        break;
      }

      await finalHandler(bufferedEnvelope);
    }

    const assignedPath = welcomeFrame.assignedPath ?? ackFrame.assignedPath;
    if (!assignedPath) {
      throw new Error("Assigned path must be present after attach handshake");
    }

    const targetPhysicalPath = ackFrame.targetPhysicalPath ?? welcomeFrame.targetPhysicalPath;
    if (!targetPhysicalPath) {
      throw new Error("Target physical path must be present after attach handshake");
    }

    const targetSystemId = ackFrame.targetSystemId;
    if (!targetSystemId) {
      throw new Error("Target system ID must be set in NodeAttachAckFrame on success");
    }

    try {
      if (this.replicaStickinessManager) {
        this.replicaStickinessManager.accept(ackFrame.stickiness ?? null);
      }
    } catch (error) {
      logger.debug("stickiness_accept_skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let attachExpiresAt: Date | undefined;
    if (ackFrame.expiresAt) {
      const candidate = new Date(ackFrame.expiresAt);
      if (!Number.isNaN(candidate.getTime())) {
        attachExpiresAt = candidate;
      }
    }

    const routingEpoch = ackFrame.routingEpoch;

    const attachInfo: AttachInfo = {
      systemId: welcomeFrame.systemId,
      targetSystemId,
      targetPhysicalPath,
      assignedPath,
      connector,
      ...(welcomeFrame.acceptedLogicals
        ? { acceptedLogicals: [...welcomeFrame.acceptedLogicals] }
        : {}),
      ...(attachExpiresAt ? { attachExpiresAt } : {}),
      ...(routingEpoch ? { routingEpoch } : {}),
      ...(parentKeys !== undefined ? { parentKeys } : {}),
    };

    return attachInfo;
  }

  private async awaitAck(connector: FameConnector): Promise<FameEnvelopeWith<NodeAttachAckFrame>> {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      if (connector.state !== ConnectorState.STARTED) {
        let errorMessage = "Connector closed while waiting for NodeAttachAck";

        if (connector.closeCode !== undefined) {
          errorMessage += ` (code=${connector.closeCode}`;
          if (connector.closeReason) {
            errorMessage += `, reason=${connector.closeReason}`;
          }
          errorMessage += ")";
        }

        if (connector.lastError) {
          errorMessage += ` - ${connector.lastError.name}: ${connector.lastError.message}`;
        }

        throw new Error(errorMessage);
      }

      const envelope = this.buffer.shift();
      if (envelope) {
        if (envelope.frame.type === "NodeAttachAck") {
          return envelope as FameEnvelopeWith<NodeAttachAckFrame>;
        }

        logger.error("unexpected_frame_during_handshake", {
          frame_type: envelope.frame.type,
        });
      }

      await delay(HANDSHAKE_POLL_INTERVAL_MS);
    }

    const timeoutError = new Error("Timeout waiting for NodeAttachAck");
    timeoutError.name = "TimeoutError";
    throw timeoutError;
  }
}
