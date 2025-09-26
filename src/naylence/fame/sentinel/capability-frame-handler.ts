import {
  CapabilityAdvertiseAckFrame,
  type CapabilityAdvertiseFrame,
  type CapabilityWithdrawFrame,
  CapabilityWithdrawAckFrame,
  DeliveryOriginType,
  FameResponseType,
  type FameAddress,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
} from 'naylence-core';

import type { RoutingNodeLike } from '../node/routing-node-like.js';
import { getLogger } from '../util/logging.js';
import type { RouteManager } from './route-manager.js';

const logger = getLogger('capability-frame-handler');

type CapabilityRoutesMap = Map<string, Map<string, CapabilityRouteEntry>>;

type CapabilityRouteEntry = {
  address: FameAddress;
  segment: string;
};

export interface CapabilityFrameHandlerOptions {
  routingNode: RoutingNodeLike;
  routeManager: RouteManager;
  upstreamConnector: () => FameConnector | null | undefined;
}

export class CapabilityFrameHandler {
  private readonly routingNode: RoutingNodeLike;
  private readonly routeManager: RouteManager;
  private readonly getUpstreamConnector: () => FameConnector | null | undefined;
  private readonly capabilityRoutes: CapabilityRoutesMap = new Map();

  constructor(options: CapabilityFrameHandlerOptions) {
    this.routingNode = options.routingNode;
    this.routeManager = options.routeManager;
    this.getUpstreamConnector = options.upstreamConnector;
  }

  public get capRoutes(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};

    for (const [capability, routes] of this.capabilityRoutes.entries()) {
      const capabilityRoutes: Record<string, string> = {};
      for (const [addressKey, entry] of routes.entries()) {
        capabilityRoutes[addressKey] = entry.segment;
      }
      result[capability] = capabilityRoutes;
    }

    return result;
  }

  public async acceptCapabilityAdvertise(
    envelope: FameEnvelope,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    const frame = envelope.frame as CapabilityAdvertiseFrame | undefined;
    if (!frame || frame.type !== 'CapabilityAdvertise') {
      throw new Error('Expected CapabilityAdvertiseFrame');
    }

    const segment = this.getSourceSystemId(context);
    if (!segment || !this.routeManager.downstreamRoutes.has(segment)) {
      logger.debug('capability_advertise_unknown_segment', { segment });
      return;
    }

    const addressKey = this.normalizeAddress(frame.address);
    let firstGlobal = false;

    for (const capability of frame.capabilities) {
      const routeEntries = this.ensureCapabilityRoutes(capability);
      const previouslyEmpty = routeEntries.size === 0;
      routeEntries.set(addressKey, { address: frame.address, segment });
      if (previouslyEmpty) {
        firstGlobal = true;
      }
    }

    const ackContext = this.buildAckContext(context);
    const ackFrame: CapabilityAdvertiseAckFrame = {
      type: 'CapabilityAdvertiseAck',
      capabilities: [...frame.capabilities],
      address: frame.address,
      ok: true,
      refId: envelope.id ?? undefined,
    };

    await this.forwardAckToSegment(segment, ackFrame, envelope, ackContext);

    if (firstGlobal && this.hasUpstream()) {
      await this.routingNode.forwardUpstream(envelope, ackContext);
    }
  }

  public async acceptCapabilityWithdraw(
    envelope: FameEnvelope,
    context: FameDeliveryContext | null | undefined
  ): Promise<void> {
    const frame = envelope.frame as CapabilityWithdrawFrame | undefined;
    if (!frame || frame.type !== 'CapabilityWithdraw') {
      throw new Error('Expected CapabilityWithdrawFrame');
    }

    const segment = this.getSourceSystemId(context);
    if (!segment) {
      logger.debug('capability_withdraw_missing_segment');
      return;
    }

    const addressKey = this.normalizeAddress(frame.address);
    let vanishedGlobal = false;

    for (const capability of frame.capabilities) {
      const routes = this.capabilityRoutes.get(capability);
      if (!routes) {
        continue;
      }

      const currentOwner = routes.get(addressKey);
      if (currentOwner && currentOwner.segment === segment) {
        routes.delete(addressKey);
        if (routes.size === 0) {
          this.capabilityRoutes.delete(capability);
          vanishedGlobal = true;
        }
      }
    }

    const ackContext = this.buildAckContext(context);
    const ackFrame: CapabilityWithdrawAckFrame = {
      type: 'CapabilityWithdrawAck',
      capabilities: [...frame.capabilities],
      address: frame.address,
      ok: true,
      refId: envelope.id ?? undefined,
    };

    await this.forwardAckToSegment(segment, ackFrame, envelope, ackContext);

    if (vanishedGlobal && this.hasUpstream()) {
      await this.routingNode.forwardUpstream(envelope, ackContext);
    }
  }

  private ensureCapabilityRoutes(capability: string): Map<string, CapabilityRouteEntry> {
    let routes = this.capabilityRoutes.get(capability);
    if (!routes) {
      routes = new Map<string, CapabilityRouteEntry>();
      this.capabilityRoutes.set(capability, routes);
    }
    return routes;
  }

  private getSourceSystemId(context: FameDeliveryContext | null | undefined): string | null {
    if (context?.fromSystemId) {
      return context.fromSystemId;
    }
    return null;
  }

  private async forwardAckToSegment(
    segment: string,
    ackFrame: CapabilityAdvertiseAckFrame | CapabilityWithdrawAckFrame,
    originalEnvelope: FameEnvelope,
    ackContext: FameDeliveryContext
  ): Promise<void> {
    const envelopeFactory = this.routingNode.envelopeFactory;
    if (!envelopeFactory) {
      logger.warning('missing_envelope_factory_for_capability_ack');
      return;
    }

    const ackEnvelope = envelopeFactory.createEnvelope({
      frame: ackFrame,
      ...(originalEnvelope.corrId ? { corrId: originalEnvelope.corrId } : {}),
    });

    await this.routingNode.forwardToRoute?.(segment, ackEnvelope, ackContext);
  }

  private hasUpstream(): boolean {
    try {
      return Boolean(this.getUpstreamConnector());
    } catch {
      return false;
    }
  }

  private buildAckContext(context: FameDeliveryContext | null | undefined): FameDeliveryContext {
    return {
      originType: DeliveryOriginType.LOCAL,
      security: context?.security,
      stickinessRequired: context?.stickinessRequired,
      stickySid: context?.stickySid,
      expectedResponseType: FameResponseType.NONE,
    };
  }

  private normalizeAddress(address: FameAddress): string {
    return address.toString();
  }
}
