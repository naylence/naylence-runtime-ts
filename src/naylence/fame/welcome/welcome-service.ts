import type { NodeHelloFrame, NodeWelcomeFrame } from "naylence-core";

import type { Authorizer } from "../security/auth/authorizer.js";

export interface WelcomeService {
  readonly authorizer?: Authorizer | null;

  handleHello(
    hello: NodeHelloFrame,
    metadata?: Record<string, unknown> | null
  ): Promise<NodeWelcomeFrame>;
}

export type WelcomeServiceMetadata = Record<string, unknown> | null | undefined;
