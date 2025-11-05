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

export {
  getNode,
  getCurrentNode,
  withNodeContextAsync,
  runWithNodeContext,
} from './naylence/fame/node/node-context-stack.js';

// Sentinel (cross-platform routing node)
export * from './naylence/fame/sentinel/index.js';

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

type PluginModuleLoader = (
  specifier: string
) => Promise<Record<string, unknown>>;

const runtimePluginModulePromise = import('./plugin.js') as Promise<
  Record<string, unknown>
>;

const globalScope = globalThis as Record<string, unknown>;

const FACTORY_MODULE_PREFIX = '@naylence/runtime/naylence/fame/';

const resolveFactoryModuleSpecifier = (specifier: string): string | null => {
  if (specifier.startsWith('../')) {
    const relativePath = specifier.slice('../'.length);
    return `${FACTORY_MODULE_PREFIX}${relativePath}`;
  }

  if (specifier.startsWith('./')) {
    const relativePath = specifier.slice('./'.length);
    return `${FACTORY_MODULE_PREFIX}${relativePath}`;
  }

  return null;
};

const ensureRuntimePluginLoader = (): PluginModuleLoader => {
  const existing = Reflect.get(
    globalScope,
    '__naylenceFactoryDynamicImporter'
  ) as PluginModuleLoader | undefined;

  if (typeof existing === 'function') {
    return existing;
  }

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

  const remapped = resolveFactoryModuleSpecifier(specifier);
    if (remapped) {
      return import(/* @vite-ignore */ remapped) as Promise<
        Record<string, unknown>
      >;
    }

    return import(/* @vite-ignore */ specifier) as Promise<
      Record<string, unknown>
    >;
  };

  Reflect.set(globalScope, '__naylenceFactoryDynamicImporter', loader);
  return loader;
};

export const __runtimePluginLoader = ensureRuntimePluginLoader();
