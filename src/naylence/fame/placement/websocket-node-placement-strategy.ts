import type { NodeHelloFrame } from "naylence-core";

import type { NodePlacementStrategy, PlacementDecision } from "./node-placement-strategy.js";
import { StaticNodePlacementStrategy } from "./static-node-placement-strategy.js";

type ParentResolver = () => string;

export interface WebSocketPlacementStrategyOptions {
  parentSystemIdFn: ParentResolver;
  parentPathFn: ParentResolver;
}

function createStaticDelegate(
  options: WebSocketPlacementStrategyOptions
): StaticNodePlacementStrategy {
  return new StaticNodePlacementStrategy({
    targetSystemId: options.parentSystemIdFn(),
    targetPhysicalPath: options.parentPathFn(),
  });
}

export class WebSocketPlacementStrategy implements NodePlacementStrategy {
  private readonly parentSystemIdFn: ParentResolver;
  private readonly parentPathFn: ParentResolver;

  public constructor(options: WebSocketPlacementStrategyOptions) {
    this.parentSystemIdFn = options.parentSystemIdFn;
    this.parentPathFn = options.parentPathFn;
  }

  public async place(helloFrame: NodeHelloFrame): Promise<PlacementDecision> {
    const delegate = createStaticDelegate({
      parentSystemIdFn: this.parentSystemIdFn,
      parentPathFn: this.parentPathFn,
    });

    return delegate.place(helloFrame);
  }
}
