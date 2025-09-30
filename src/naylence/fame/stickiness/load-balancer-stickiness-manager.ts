import type { FameEnvelope, Stickiness } from "naylence-core";

export interface LoadBalancerStickinessManager {
  negotiate(stickiness?: Stickiness | null): Stickiness | null;
  getStickyReplicaSegment(
    envelope: FameEnvelope,
    segments?: readonly string[] | null
  ): string | null;
}
