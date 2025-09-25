import type {
  AuthorizationContext,
  DeliveryOriginType,
  FameConnector,
  FameDeliveryContext,
  FameEnvelope,
} from 'naylence-core';

import type { WebSocketConnectorConfig, WebSocketLike } from '../connector/websocket-connector.js';
import type { NodeLike } from './node-like.js';

export interface OriginConnectorOptions {
  originType: DeliveryOriginType;
  systemId: string;
  connectorConfig: WebSocketConnectorConfig;
  websocket: WebSocketLike;
  authorization?: AuthorizationContext | undefined;
  [key: string]: unknown;
}

export interface RoutingNodeLike extends NodeLike {
  createOriginConnector(options: OriginConnectorOptions): Promise<FameConnector>;
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
}
