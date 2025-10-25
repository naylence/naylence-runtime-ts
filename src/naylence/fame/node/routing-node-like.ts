import type {
  AuthorizationContext,
  DeliveryOriginType,
  FameConnector,
  FameDeliveryContext,
  FameEnvelope,
} from '@naylence/core';

import type { ConnectorConfig } from '../connector/connector-config.js';
import type { WebSocketLike } from '../connector/websocket-connector.js';
import type { NodeLike } from './node-like.js';
import type { RouteRemovalOptions } from '../sentinel/route-manager.js';

export interface OriginConnectorOptions {
  originType: DeliveryOriginType;
  systemId: string;
  connectorConfig: ConnectorConfig;
  websocket?: WebSocketLike;
  authorization?: AuthorizationContext | undefined;
  [key: string]: unknown;
}

export interface RoutingNodeLike extends NodeLike {
  createOriginConnector(
    options: OriginConnectorOptions
  ): Promise<FameConnector>;
  bumpRoutingEpoch?(): void;
  forwardToPeers?(
    envelope: FameEnvelope,
    peers?: unknown,
    excludePeers?: unknown,
    context?: FameDeliveryContext
  ): Promise<void>;
  forwardToRoute?(
    nextSegment: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void>;
  forwardToPeer?(
    nextSegment: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void>;
  removeDownstreamRoute?(
    segment: string,
    options?: RouteRemovalOptions
  ): Promise<void> | void;
  removePeerRoute?(
    segment: string,
    options?: RouteRemovalOptions
  ): Promise<void> | void;
}
