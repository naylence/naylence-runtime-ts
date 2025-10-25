import type {
  FameConnector,
  FameEnvelopeHandler,
  NodeWelcomeFrame,
  DeliveryOriginType,
} from '@naylence/core';
import type { NodeLike } from '../node-like.js';

export interface AttachInfo {
  readonly systemId: string;
  readonly targetSystemId: string;
  readonly targetPhysicalPath: string;
  readonly assignedPath: string;
  readonly acceptedLogicals?: string[];
  readonly attachExpiresAt?: Date;
  readonly routingEpoch?: string;
  readonly connector?: FameConnector;
  readonly parentKeys?: Array<Record<string, unknown>>;
}

export interface NodeAttachClient {
  attach(
    node: NodeLike,
    originType: DeliveryOriginType,
    connector: FameConnector,
    welcomeFrame: NodeWelcomeFrame,
    finalHandler: FameEnvelopeHandler,
    keys?: Array<Record<string, unknown>>,
    callbackGrants?: Array<Record<string, unknown>>
  ): Promise<AttachInfo>;
}
