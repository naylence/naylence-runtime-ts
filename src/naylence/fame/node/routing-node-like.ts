import type { AuthorizationContext, DeliveryOriginType, FameConnector } from 'naylence-core';

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
}
