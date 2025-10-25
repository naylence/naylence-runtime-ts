/**
 * Browser-friendly entry point for Naylence Runtime.
 *
 * Exposes utilities, channels, connectors, and cross-platform helpers that
 * do not rely on Node.js-only dependencies. This file purposefully excludes
 * modules such as the SQLite storage providers and any prompt utilities that
 * expect access to the Node.js standard library.
 */

// Re-export everything from naylence-core for protocol primitives
export * from '@naylence/core';

// Cross-platform Fame runtime exports
export * from './naylence/fame/errors/index.js';
export * from './naylence/fame/util/index.js';
export * from './naylence/fame/channel/index.js';

// Storage providers that are safe for browsers (in-memory + IndexedDB)
export * from './naylence/fame/storage/index.js';

// Connector layer exports trimmed to browser-safe components
export {
  BaseAsyncConnector,
  BaseAsyncConnectorConfig,
} from './naylence/fame/connector/base-async-connector.js';
export {
  ConnectorConfig,
  ConnectorConfigDefaults,
  isConnectorConfig,
  createConnectorConfig,
} from './naylence/fame/connector/connector-config.js';
export {
  ConnectorFactory,
  createResource,
} from './naylence/fame/connector/connector-factory.js';
export type { ConnectionGrant } from './naylence/fame/connector/connector-factory.js';
export {
  WebSocketConnector,
  WebSocketConnectorConfig,
  WebSocketLike,
  WebSocketState,
} from './naylence/fame/connector/websocket-connector.js';
export type { AuthorizationContext as WebSocketAuthorizationContext } from './naylence/fame/connector/websocket-connector.js';
export { _NoopFlowController } from './naylence/fame/connector/noop-flow-controller.js';

// RPC helpers are shared
export {
  RpcProxy,
  createRpcProxy,
  RpcMixin,
  operation,
} from './naylence/fame/service/rpc.js';

// Runtime factory registration exposes no Node.js specifics
export {
  registerDefaultFactories,
  registerRuntimeFactories,
  type RuntimeFactoryRegistry,
} from './naylence/fame/util/register-runtime-factories.js';
