import './naylence/fame/connector/websocket-connector-node-ssl.js';

// Ensure Node-specific registrations (storage, sqlite, etc.) happen before
// the isomorphic exports are evaluated. Some factories (SQLite) must be
// registered early so configuration parsing that happens during runtime
// initialization can resolve the requested storage profiles.
import './naylence/fame/storage/node-index.js'; // Side-effect: registers SQLite profiles

// Auto-register the runtime plugin if we are in a Node.js environment
if (typeof process !== 'undefined' && process.env) {
  const pluginName = '@naylence/runtime';
  const current = process.env.FAME_PLUGINS || '';
  const plugins = current.split(',').map((p) => p.trim());
  if (!plugins.includes(pluginName)) {
    process.env.FAME_PLUGINS = current
      ? `${current},${pluginName}`
      : pluginName;
  }
}

export * from './naylence/fame/storage/node-index.js';

export * from './runtime-isomorphic.js';
export * from './naylence/fame/node/index.js';
export * from './naylence/fame/security/index.js';
export * from './naylence/fame/stickiness/index.js';
export * from './naylence/fame/grants/index.js';
export * from './naylence/fame/placement/node-placement-strategy.js';
export * from './naylence/fame/placement/node-placement-strategy-factory.js';
export * from './naylence/fame/transport/transport-provisioner.js';
export * from './naylence/fame/welcome/index.js';
export * from './naylence/fame/sentinel/index.js';

export {
  HttpStatelessConnector,
  QueueFullError,
  type HttpStatelessConnectorConfig,
  DefaultHttpServer,
  getWebsocketListenerInstance,
  TransportListener,
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  type TransportListenerConfig,
  type HttpServer,
  type HttpRouter,
  WebSocketListener,
  HttpListener,
  getHttpListenerInstance,
  InPageListener,
  getInPageListenerInstance,
} from './naylence/fame/connector/index.js';
export { safeImport } from './naylence/fame/util/lazy-import.js';

export {
  InProcessFameFabric,
  InProcessFameFabricFactory,
  FAME_FABRIC_FACTORY_BASE_TYPE,
} from './naylence/fame/fabric/index.js';
export {
  normalizeExtendedFameConfig,
  type ExtendedFameConfig,
} from './naylence/fame/config/index.js';

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
