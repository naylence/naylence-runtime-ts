import type { Stickiness } from "naylence-core";

export interface ReplicaStickinessManager {
  offer(): Stickiness | null;
  accept(stickiness: Stickiness | null): void;
}
