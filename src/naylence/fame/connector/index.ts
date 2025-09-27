import { ExtensionManager as ConnectorExtensionManager } from './connector-factory.js';
import { WebSocketConnectorFactory } from './websocket-connector-factory.js';

ConnectorExtensionManager.register(WebSocketConnectorFactory);

/**
 * Fame Connector Exports
 */

// Base connector
export { BaseAsyncConnector, BaseAsyncConnectorConfig } from './base-async-connector.js';

// Connector infrastructure  
export { ConnectorConfig, ResourceConfig, ConnectorConfigDefaults, isConnectorConfig, createConnectorConfig } from './connector-config.js';
export { 
  ConnectorFactory as RuntimeConnectorFactory, 
  ResourceFactory as RuntimeResourceFactory, 
  ConnectionGrant, 
  ExpressionEvaluationPolicy,
  createResource 
} from './connector-factory.js';
export { ConnectorExtensionManager as ExtensionManager };

// WebSocket connector
export { 
  WebSocketConnector, 
  WebSocketConnectorConfig, 
  WebSocketLike,
  AuthorizationContext as WebSocketAuthorizationContext,
  WebSocketState 
} from './websocket-connector.js';

// WebSocket connector factory
export {
  WebSocketConnectorFactory,
  WebSocketConnectorFactoryConfig,
  CreateWebSocketConnectorOptions
} from './websocket-connector-factory.js';

export {
  WebSocketListenerFactory,
  type WebSocketListenerFactoryConfig,
} from './websocket-listener-factory.js';

// Flow controller
export { _NoopFlowController } from './noop-flow-controller.js';

// Transport listener
export { TransportListener } from './transport-listener.js';
export { TransportListenerFactory, TRANSPORT_LISTENER_FACTORY_BASE_TYPE } from './transport-listener-factory.js';
export type { TransportListenerConfig } from './transport-listener-config.js';
export type { HttpServer, HttpRouter } from './http-server.js';
export { DefaultHttpServer } from './default-http-server.js';
export { WebSocketListener, getWebsocketListenerInstance } from './websocket-listener.js';
export { HttpListener, getHttpListenerInstance } from './http-listener.js';
export {
  HttpListenerFactory,
  type HttpListenerFactoryConfig,
  type CreateHttpListenerOptions,
} from './http-listener-factory.js';