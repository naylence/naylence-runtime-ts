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
  targetSystemId?: string;
  targetPhysicalPath?: string;
  target_system_id?: string;
  target_physical_path?: string;
}

function normalizeOptions(
  options: StaticNodePlacementStrategyOptions | null | undefined
): { targetSystemId: string; targetPhysicalPath: string } {
  if (!options || typeof options !== 'object') {
    throw new TypeError(
      'StaticNodePlacementStrategy options must be an object'
    );
  }

  const targetSystemId =
    options.targetSystemId ?? options.target_system_id ?? null;
  const targetPhysicalPath =
    options.targetPhysicalPath ?? options.target_physical_path ?? null;

  if (!targetSystemId) {
    throw new Error('StaticNodePlacementStrategy requires targetSystemId');
  }
  if (!targetPhysicalPath) {
    throw new Error('StaticNodePlacementStrategy requires targetPhysicalPath');
  }

  return {
    targetSystemId,
    targetPhysicalPath,
  };
}

export class StaticNodePlacementStrategy implements NodePlacementStrategy {
  private readonly targetSystemId: string;
  private readonly targetPhysicalPath: string;

  public constructor(options: StaticNodePlacementStrategyOptions) {
    const normalized = normalizeOptions(options);

    this.targetSystemId = normalized.targetSystemId;
    this.targetPhysicalPath = normalized.targetPhysicalPath;
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
