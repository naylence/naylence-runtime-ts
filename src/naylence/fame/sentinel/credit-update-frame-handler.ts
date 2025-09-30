import type { FameDeliveryContext, FameEnvelope } from "naylence-core";

import { getLogger } from "../util/logging.js";
import type { RouteManager } from "./route-manager.js";

const logger = getLogger("credit-update-frame-handler");

export interface CreditUpdateFrameHandlerOptions {
  routeManager: RouteManager;
}

export class CreditUpdateFrameHandler {
  private readonly routeManager: RouteManager;

  constructor(options: CreditUpdateFrameHandlerOptions) {
    this.routeManager = options.routeManager;
  }

  public async acceptCreditUpdate(
    envelope: FameEnvelope,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    const flowId = envelope.flowId;
    if (!flowId) {
      logger.warning("credit_update_missing_flow_id");
      return;
    }

    const targetConnector = this.routeManager.getFlowRoute(flowId);
    if (!targetConnector) {
      logger.warning("credit_update_unknown_flow", { flowId });
      return;
    }

    if (context?.fromConnector && context.fromConnector === targetConnector) {
      return;
    }

    await targetConnector.send(envelope);
  }
}
