import type { DeliveryOriginType } from "naylence-core";

import type { NodeEventListener } from "../../node/node-event-listener.js";
import type { KeyProvider } from "./key-provider.js";
import type { KeyRecord } from "./key-store.js";

export interface KeyManager extends NodeEventListener, KeyProvider {
  hasKey(kid: string): Promise<boolean>;

  addKeys(options: {
    keys: Array<Record<string, unknown>>;
    sid?: string;
    physicalPath: string;
    systemId: string;
    origin: DeliveryOriginType;
    skipSidValidation?: boolean;
  }): Promise<void>;

  announceKeysToUpstream(): Promise<void>;

  handleKeyRequest(options: {
    kid: string;
    fromSegment: string;
    physicalPath?: string;
    origin: DeliveryOriginType;
    correlationId?: string;
    originalClientSid?: string;
  }): Promise<void>;

  removeKeysForPath(physicalPath: string): Promise<number>;

  getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>>;
}
