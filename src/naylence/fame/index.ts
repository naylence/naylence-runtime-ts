/**
 * Fame protocol modules
 */

export * from "./connector/index.js";
export * from "./errors/index.js";
export * from "./node/index.js";
export * from "./delivery/index.js";
export * from "./security/index.js";
export * from "./storage/index.js";
export * from "./util/index.js";
export * from "./constants/index.js";
export * from "./stickiness/index.js";
export * from "./sentinel/index.js";
export * from "./welcome/index.js";
export * from "./fabric/index.js";
export * from "./telemetry/index.js";
export * from "./server/index.js";

// Placement
export {
  NODE_PLACEMENT_STRATEGY_FACTORY_BASE_TYPE,
  NodePlacementStrategyFactory,
  type NodePlacementStrategy,
  type PlacementDecision,
  type NodePlacementConfig,
  registerNodePlacementStrategyFactory,
} from "./placement/node-placement-strategy.js";

export {
  StaticNodePlacementStrategy,
  type StaticNodePlacementStrategyOptions,
} from "./placement/static-node-placement-strategy.js";

export {
  StaticNodePlacementStrategyFactory,
  type StaticNodePlacementConfig,
} from "./placement/static-node-placement-strategy-factory.js";

export {
  WebSocketPlacementStrategy,
  type WebSocketPlacementStrategyOptions,
} from "./placement/websocket-node-placement-strategy.js";

export {
  WebSocketPlacementStrategyFactory,
  type WebSocketPlacementConfig,
} from "./placement/websocket-node-placement-strategy-factory.js";

// Transport
export {
  TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE,
  TransportProvisionerFactory,
  type TransportProvisioner,
  type TransportProvisionerConfig,
  type TransportProvisionResult,
} from "./transport/transport-provisioner.js";

export {
  WebSocketTransportProvisioner,
  WebSocketTransportProvisionerFactory,
  type WebSocketTransportProvisionerConfig,
} from "./transport/websocket-transport-provisioner.js";
