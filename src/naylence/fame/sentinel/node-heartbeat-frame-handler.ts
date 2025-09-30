import {
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  NodeHeartbeatAckFrame,
  NodeHeartbeatFrame,
} from "naylence-core";

import type { RoutingNodeLike } from "../node/routing-node-like.js";
import { getLogger } from "../util/logging.js";

const logger = getLogger("node-heartbeat-frame-handler");

type RoutingNodeWithEpoch = RoutingNodeLike & {
  readonly routingEpoch?: string | null | undefined;
};

export class NodeHeartbeatFrameHandler {
  private readonly routingNode: RoutingNodeWithEpoch;

  constructor(options: { routingNode: RoutingNodeLike }) {
    this.routingNode = options.routingNode as RoutingNodeWithEpoch;
  }

  public async acceptNodeHeartbeat(
    envelope: FameEnvelope,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    const frame = envelope.frame as NodeHeartbeatFrame | undefined;
    if (!frame || frame.type !== "NodeHeartbeat") {
      throw new Error(
        `Invalid envelope frame. Expected: NodeHeartbeatFrame, actual: ${frame?.type ?? "unknown"}`
      );
    }

    logger.trace("handling_heartbeat", {
      hb_system_id: frame.systemId ?? "unknown",
      hb_env_id: envelope.id ?? "unknown",
      hb_corr_id: envelope.corrId ?? "unknown",
    });

    if (!context) {
      throw new Error("missing FameDeliveryContext");
    }

    const connector = context.fromConnector as FameConnector | undefined;
    if (!connector) {
      throw new Error("Connector in context does not match pending connector");
    }

    const ackFrame: NodeHeartbeatAckFrame = {
      type: "NodeHeartbeatAck",
      ok: true,
      ...(envelope.id ? { refId: envelope.id } : {}),
      ...(this.routingNode.routingEpoch ? { routingEpoch: this.routingNode.routingEpoch } : {}),
    };

    if (frame.address) {
      ackFrame.address = frame.address;
    }

    const ackEnvelope = this.routingNode.envelopeFactory.createEnvelope({
      frame: ackFrame,
      ...(envelope.corrId ? { corrId: envelope.corrId } : {}),
      ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
    });

    logger.debug("sending_heartbeat_ack", {
      hb_ack_env_id: ackEnvelope.id ?? "unknown",
      hb_ack_corr_id: ackEnvelope.corrId ?? "unknown",
    });

    await this.sendAndNotify(connector, ackEnvelope, frame.systemId ?? "unknown", context);
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
