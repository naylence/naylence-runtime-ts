import type { FameEnvelopeWith, NodeWelcomeFrame } from 'naylence-core';

export interface HelloOptions {
  readonly systemId?: string;
  readonly requestedLogicals?: string[];
  readonly instanceId?: string;
}

/**
 * Admission client performs the hello → welcome handshake with an upstream service.
 */
export interface AdmissionClient {
  readonly hasUpstream: boolean;

  hello(
    systemId: string,
    instanceId: string,
    requestedLogicals?: string[]
  ): Promise<FameEnvelopeWith<NodeWelcomeFrame>>;

  close(): Promise<void>;
}
