import type { FameDeliveryContext, FameEnvelope } from '@naylence/core';

import { getLogger } from '../util/logging.js';
import type { RouteManager } from './route-manager.js';

const logger = getLogger('naylence.fame.sentinel.credit_update_frame_handler');

export interface CreditUpdateFrameHandlerOptions {
  routeManager: RouteManager;
}

type CreditUpdateFrameHandlerOptionsInput =
  | CreditUpdateFrameHandlerOptions
  | Record<string, unknown>
  | null
  | undefined;

function normalizeOptions(
  options?: CreditUpdateFrameHandlerOptionsInput
): CreditUpdateFrameHandlerOptions {
  if (!options || typeof options !== 'object') {
    throw new Error('CreditUpdateFrameHandler requires a routeManager option');
  }

  const candidate = options as Record<string, unknown>;
  const routeManager = (candidate.routeManager ?? candidate.route_manager) as
    | RouteManager
    | undefined;

  if (!routeManager) {
    throw new Error('CreditUpdateFrameHandler requires a routeManager option');
  }

  return { routeManager };
}

export class CreditUpdateFrameHandler {
  private readonly routeManager: RouteManager;

  constructor(options: CreditUpdateFrameHandlerOptionsInput) {
    const normalized = normalizeOptions(options);
    this.routeManager = normalized.routeManager;
  }

  public async acceptCreditUpdate(
    envelope: FameEnvelope,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    const flowId = envelope.flowId;
    if (!flowId) {
      logger.warning('credit_update_missing_flow_id');
      return;
    }

    const targetConnector = this.routeManager.getFlowRoute(flowId);
    if (!targetConnector) {
      logger.warning('credit_update_unknown_flow', { flowId });
      return;
    }

    if (context?.fromConnector && context.fromConnector === targetConnector) {
      return;
    }

    await targetConnector.send(envelope);
  }
}
