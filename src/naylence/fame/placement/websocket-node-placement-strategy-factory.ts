import { z } from "zod";

import { getNode } from "../node/node-context-stack.js";
import type { NodeLike } from "../node/node-like.js";

import {
  NodePlacementStrategyFactory,
  registerNodePlacementStrategyFactory,
  type NodePlacementStrategy,
  type NodePlacementConfig,
} from "./node-placement-strategy.js";
import { WebSocketPlacementStrategy } from "./websocket-node-placement-strategy.js";

export interface WebSocketPlacementConfig extends NodePlacementConfig {
  type: "WebSocketNodePlacementStrategy";
}

const webSocketPlacementConfigSchema = z
  .object({
    type: z.literal("WebSocketNodePlacementStrategy").default("WebSocketNodePlacementStrategy"),
  })
  .passthrough();

function emitFactoryDeprecationWarning(): void {
  const message =
    "WebSocketPlacementStrategyFactory is deprecated; use StaticNodePlacementStrategyFactory";
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message, { type: "DeprecationWarning" });
  } else {
    console.warn(message);
  }
}

function resolveParentSystemId(node: NodeLike): string {
  return node.id;
}

export class WebSocketPlacementStrategyFactory extends NodePlacementStrategyFactory<WebSocketPlacementConfig> {
  public readonly type = "WebSocketNodePlacementStrategy";
  private readonly parentSystemIdFn: (() => string) | null;
  private readonly parentPathFn: (() => string) | null;

  public constructor(...args: unknown[]) {
    super();
    const [parentSystemIdFn, parentPathFn] = args as [
      (() => string) | null | undefined,
      (() => string) | null | undefined,
    ];
    this.parentSystemIdFn = parentSystemIdFn ?? null;
    this.parentPathFn = parentPathFn ?? null;
  }

  public async create(
    config?: WebSocketPlacementConfig | Record<string, unknown> | null
  ): Promise<NodePlacementStrategy> {
    if (!config) {
      throw new Error("WebSocketPlacementStrategyFactory requires configuration");
    }

    const parsed = webSocketPlacementConfigSchema.parse(config);
    emitFactoryDeprecationWarning();
    void parsed; // parsed is currently unused but ensures validation runs

    let node: NodeLike | null = null;
    if (!this.parentSystemIdFn || !this.parentPathFn) {
      node = getNode();
    }

    const parentSystemId = this.parentSystemIdFn
      ? this.parentSystemIdFn()
      : resolveParentSystemId(node!);
    const parentPhysicalPath = this.parentPathFn
      ? this.parentPathFn()
      : (node ?? getNode()).physicalPath;

    return new WebSocketPlacementStrategy({
      parentSystemIdFn: () => parentSystemId,
      parentPathFn: () => parentPhysicalPath,
    });
  }
}

registerNodePlacementStrategyFactory(
  "WebSocketNodePlacementStrategy",
  WebSocketPlacementStrategyFactory
);
