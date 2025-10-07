import type { NodeHelloFrame } from 'naylence-core';

export interface PlacementDecision {
  accept: boolean;
  assignedPath: string;
  targetSystemId?: string | null;
  targetPhysicalPath?: string | null;
  acceptedLogicals?: string[] | null;
  rejectedLogicals?: string[] | null;
  metadata?: Record<string, unknown> | null;
  expiresAt?: Date | string | null;
  reason?: string | null;
  [key: string]: unknown;
}

export interface NodePlacementStrategy {
  place(helloFrame: NodeHelloFrame): Promise<PlacementDecision>;
}
