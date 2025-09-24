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
  ExtensionManager, 
  ExpressionEvaluationPolicy,
  createResource 
} from './connector-factory.js';

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
  WebSocketConnectionGrant,
  AuthInjectionStrategyConfig,
  CreateWebSocketConnectorOptions
} from './websocket-connector-factory.js';

// Flow controller
export { _NoopFlowController } from './noop-flow-controller.js';

// Transport listener
export { TransportListener } from './transport-listener.js';
export { WebSocketListener, getWebsocketListenerInstance } from './websocket-listener.js';