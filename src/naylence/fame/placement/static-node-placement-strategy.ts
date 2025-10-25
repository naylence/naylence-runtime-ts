import type { NodeHelloFrame } from '@naylence/core';

import type {
  NodePlacementStrategy,
  PlacementDecision,
} from './node-placement-strategy.js';

function joinPosixPath(parent: string, segment: string): string {
  const parentPart = parent.split('/').filter(Boolean).join('/');
  const segmentPart = segment.split('/').filter(Boolean).join('/');
  const combined = [parentPart, segmentPart].filter(Boolean).join('/');
  return `/${combined}`;
}

function buildAssignedPath(parentPath: string, childId: string): string {
  return joinPosixPath(parentPath, childId);
}

export interface StaticNodePlacementStrategyOptions {
  targetSystemId: string;
  targetPhysicalPath: string;
}

export class StaticNodePlacementStrategy implements NodePlacementStrategy {
  private readonly targetSystemId: string;
  private readonly targetPhysicalPath: string;

  public constructor(options: StaticNodePlacementStrategyOptions) {
    this.targetSystemId = options.targetSystemId;
    this.targetPhysicalPath = options.targetPhysicalPath;
  }

  public async place(helloFrame: NodeHelloFrame): Promise<PlacementDecision> {
    if (helloFrame.systemId === this.targetSystemId) {
      return {
        accept: true,
        targetSystemId: null,
        targetPhysicalPath: null,
        assignedPath: `/${helloFrame.systemId}`,
        metadata: {
          accepted_logicals: helloFrame.logicals ?? null,
          accepted_capabilities: helloFrame.capabilities ?? null,
        },
      };
    }

    return {
      accept: true,
      targetSystemId: this.targetSystemId,
      targetPhysicalPath: this.targetPhysicalPath,
      assignedPath: buildAssignedPath(
        this.targetPhysicalPath,
        helloFrame.systemId
      ),
      metadata: {
        accepted_logicals: helloFrame.logicals ?? null,
        accepted_capabilities: helloFrame.capabilities ?? null,
      },
    };
  }
}
