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

export { getNode, getCurrentNode, withNodeContextAsync, runWithNodeContext } from './naylence/fame/node/node-context-stack.js';

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

// Browser-facing crypto helpers
export {
  hasCryptoSupport,
  requireCryptoSupport,
} from './naylence/fame/security/crypto/crypto-dependencies.js';
export {
  BrowserWrappedKeyCredentialProvider,
  InvalidPassphraseError,
} from './naylence/fame/security/credential/browser-wrapped-key-credential-provider.js';

const isBrowserEnvironment =
  typeof window !== 'undefined' && typeof document !== 'undefined';

if (isBrowserEnvironment) {
  type PluginModuleLoader = (
    specifier: string
  ) => Promise<Record<string, unknown>>;

  const runtimePluginModulePromise = import('./plugin.js') as Promise<
    Record<string, unknown>
  >;

  const globalScope = globalThis as {
    __naylenceFactoryDynamicImporter?: PluginModuleLoader;
  };

  if (typeof globalScope.__naylenceFactoryDynamicImporter !== 'function') {
    const loader: PluginModuleLoader = async (
      specifier: string
    ): Promise<Record<string, unknown>> => {
      if (
        specifier === '@naylence/runtime' ||
        specifier === '@naylence/runtime/' ||
        specifier === '@naylence/runtime/plugin' ||
        specifier === '@naylence/runtime/plugin.js' ||
        specifier === '@naylence/runtime/dist/esm/plugin.js'
      ) {
        return runtimePluginModulePromise;
      }

      return import(
        /* @vite-ignore */ specifier
      ) as Promise<Record<string, unknown>>;
    };

    globalScope.__naylenceFactoryDynamicImporter = loader;
  }
}
