// Register Node-specific extensions before re-exporting modules
import './naylence/fame/connector/websocket-connector-node-ssl.js';

// Re-export everything from naylence-core
export * from '@naylence/core';

// Export naylence runtime modules selectively to avoid conflicts
export * from './naylence/fame/errors/index.js';
export * from './naylence/fame/util/index.js';
export * from './naylence/fame/storage/index.js';
export * from './naylence/fame/storage/node-index.js';
export * from './naylence/fame/node/index.js';
export * from './naylence/fame/security/index.js';
export * from './naylence/fame/stickiness/index.js';
export * from './naylence/fame/grants/index.js';
export * from './naylence/fame/placement/node-placement-strategy.js';
export * from './naylence/fame/placement/node-placement-strategy-factory.js';
export * from './naylence/fame/transport/transport-provisioner.js';
export * from './naylence/fame/welcome/index.js';
export * from './naylence/fame/sentinel/index.js';

// Export connector modules with aliases to avoid conflicts with naylence-core
export {
  // Base connector
  BaseAsyncConnector,
  BaseAsyncConnectorConfig,

  // Connector infrastructure (with aliases)
  ConnectorConfig,
  ConnectorConfigDefaults,
  isConnectorConfig,
  createConnectorConfig,
  ConnectionGrant,
  createResource,

  // WebSocket connector
  WebSocketConnector,
  WebSocketConnectorConfig,
  WebSocketLike,
  WebSocketAuthorizationContext,
  WebSocketState,

  // HTTP stateless connector
  HttpStatelessConnector,
  QueueFullError,
  type HttpStatelessConnectorConfig,

  // Flow controller
  _NoopFlowController,
  DefaultHttpServer,
  getWebsocketListenerInstance,
} from './naylence/fame/connector/index.js';

export {
  InProcessFameFabric,
  InProcessFameFabricFactory,
  FAME_FABRIC_FACTORY_BASE_TYPE,
} from './naylence/fame/fabric/index.js';
export {
  normalizeExtendedFameConfig,
  type ExtendedFameConfig,
} from './naylence/fame/config/index.js';

// Export channel implementations
export * from './naylence/fame/channel/index.js';

// Export RPC service utilities
export {
  RpcProxy,
  createRpcProxy,
  RpcMixin,
  operation,
} from './naylence/fame/service/rpc.js';

// Export factory registration helpers
export { registerDefaultFactories } from './naylence/fame/util/register-runtime-factories.js';
export {
  registerRuntimeFactories,
  type RuntimeFactoryRegistry,
} from './naylence/fame/util/register-runtime-factories.js';

// Export HTTP/OAuth2 development server utilities
export {
  createJwksRouter,
  type CreateJwksRouterOptions,
} from './naylence/fame/http/jwks-api-router.js';
export {
  createOAuth2TokenRouter,
  type CreateOAuth2TokenRouterOptions,
} from './naylence/fame/http/oauth2-token-router.js';
export {
  createOpenIDConfigurationRouter,
  type CreateOpenIDConfigurationRouterOptions,
} from './naylence/fame/http/openid-configuration-router.js';
export {
  createApp as createOAuth2ServerApp,
  main as runOAuth2Server,
} from './naylence/fame/http/oauth2-server.js';
