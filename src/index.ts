/**
 * Naylence Runtime - TypeScript implementation
 *
 * Complete TypeScript runtime library for the Naylence Fame protocol.
 * Includes cross-platform logging, async task management, error handling,
 * formatting utilities, metrics collection, and general utility functions.
 *
 * This package mirrors the Python naylence-runtime-python structure,
 * providing equivalent functionality for TypeScript/JavaScript environments.
 *
 * Features:
 * - Fame protocol error classes with WebSocket close codes
 * - Cross-platform structured logging (Node.js + browser)
 * - Promise-based async task spawning and management
 * - Terminal output formatting with ANSI colors
 * - Metrics collection interfaces (counter, gauge, histogram)
 * - General utilities for JSON, strings, paths, hashing, etc.
 *
 * @example
 * ```typescript
 * import {
 *   getLogger,
 *   TaskSpawner,
 *   FameTransportClose,
 *   formatTimestamp,
 *   secureDigest
 * } from 'naylence-runtime';
 *
 * // Structured logging
 * const logger = getLogger('my-app');
 * logger.info('Application started', { version: '1.0.0' });
 *
 * // Async task management
 * const spawner = new TaskSpawner();
 * const task = spawner.spawn(async () => {
 *   await new Promise(resolve => setTimeout(resolve, 1000));
 *   return 'Task completed';
 * });
 *
 * // Error handling
 * try {
 *   // WebSocket connection logic
 * } catch (error) {
 *   if (error instanceof FameTransportClose) {
 *     console.log('Transport closed:', error.code);
 *   }
 * }
 * ```
 */

// Register Node-specific extensions before re-exporting modules
import "./naylence/fame/connector/websocket-connector-node-ssl.js";

// Re-export everything from naylence-core
export * from "naylence-core";
 
// Export naylence runtime modules selectively to avoid conflicts
export * from "./naylence/fame/errors/index.js";
export * from "./naylence/fame/util/index.js";
export * from "./naylence/fame/storage/index.js";
export * from "./naylence/fame/storage/node-index.js";

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

  // Flow controller
  _NoopFlowController,
} from "./naylence/fame/connector/index.js";

export {
  InProcessFameFabric,
  InProcessFameFabricFactory,
  FAME_FABRIC_FACTORY_BASE_TYPE,
} from "./naylence/fame/fabric/index.js";
export {
  normalizeExtendedFameConfig,
  type ExtendedFameConfig,
} from "./naylence/fame/config/index.js";

// Export channel implementations
export * from "./naylence/fame/channel/index.js";

// Export RPC service utilities
export {
  RpcProxy,
  createRpcProxy,
  RpcMixin,
  operation,
} from "./naylence/fame/service/rpc.js";

// Export factory registration helpers
export { registerDefaultFactories } from "./naylence/runtime/register-runtime-factories.js";
export {
  registerRuntimeFactories,
  type RuntimeFactoryRegistry,
} from "./naylence/runtime/register-runtime-factories.js";
