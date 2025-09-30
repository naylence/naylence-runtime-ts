import {
  DeliveryOriginType,
  localDeliveryContext,
  type EnvelopeFactory,
  type KeyAnnounceFrame,
} from "naylence-core";

import { currentTraceId } from "../../util/envelope-context.js";
import { getLogger } from "../../util/logging.js";
import { secureDigest } from "../../util/util.js";
import type { NodeLike } from "../../node/node-like.js";
import type { RoutingNodeLike } from "../../node/routing-node-like.js";
import {
  JWKValidationError,
  validateJwkComplete,
  type JsonWebKey,
} from "../crypto/jwk-validation.js";
import type { KeyManager } from "./key-manager.js";
import type { KeyRecord, KeyStore } from "./key-store.js";

const logger = getLogger("default-key-manager");

function normalizePhysicalPath(path: string | null | undefined): string {
  if (!path) {
    return "/";
  }
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  if (path === "/") {
    return "/";
  }
  return path.replace(/\/+$/, "") || "/";
}

function appendPath(base: string, segment: string): string {
  const normalizedBase = normalizePhysicalPath(base);
  const trimmedSegment = (segment ?? "").replace(/^\/+|\/+$/g, "");
  if (!trimmedSegment) {
    return normalizedBase;
  }
  if (normalizedBase === "/") {
    return `/${trimmedSegment}`;
  }
  return `${normalizedBase}/${trimmedSegment}`;
}

function parentPath(path: string): string {
  const normalized = normalizePhysicalPath(path);
  if (normalized === "/") {
    return "/";
  }
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function isRoutingNode(node: NodeLike): node is RoutingNodeLike {
  return typeof (node as RoutingNodeLike).createOriginConnector === "function";
}

function ensureEnvelopeFactory(factory: EnvelopeFactory | null): EnvelopeFactory {
  if (!factory) {
    throw new Error("Envelope factory not available - key manager not properly initialized");
  }
  return factory;
}

function ensureNode<T>(value: T | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export class DefaultKeyManager implements KeyManager {
  public readonly priority = 1000;

  private readonly keyStore: KeyStore;
  private node: NodeLike | null = null;
  private routingNode: RoutingNodeLike | null = null;

  constructor(options: { keyStore: KeyStore }) {
    this.keyStore = options.keyStore;
  }

  public async onNodeStarted(node: NodeLike): Promise<void> {
    this.node = node;
    this.routingNode = isRoutingNode(node) ? node : null;

    logger.debug("key_manager_started", {
      node_id: this.nodeId,
      physical_path: this.physicalPath,
      has_upstream: this.hasUpstream,
    });
  }

  public async onNodeStopped(_node: NodeLike): Promise<void> {
    logger.debug("key_manager_stopped", { node_id: this.nodeId });
  }

  public async getKey(kid: string): Promise<KeyRecord> {
    return this.keyStore.getKey(kid);
  }

  public async hasKey(kid: string): Promise<boolean> {
    return this.keyStore.hasKey(kid);
  }

  public async addKeys(options: {
    keys: Array<Record<string, unknown>>;
    sid?: string;
    physicalPath: string;
    systemId: string;
    origin: DeliveryOriginType;
    skipSidValidation?: boolean;
  }): Promise<void> {
    const { keys, sid, physicalPath, systemId, origin, skipSidValidation = false } = options;

    const validKeys: Array<Record<string, unknown>> = [];
    let rejectedCount = 0;

    for (const key of keys) {
      try {
        validateJwkComplete(key as JsonWebKey);
        validKeys.push(key);
      } catch (error) {
        if (error instanceof JWKValidationError) {
          logger.warning("rejected_invalid_jwk_in_announce", {
            kid: typeof key?.kid === "string" ? key.kid : "unknown",
            from_system_id: systemId,
            from_physical_path: physicalPath,
            error: error.message,
          });
          rejectedCount += 1;
        } else {
          throw error;
        }
      }
    }

    if (validKeys.length === 0) {
      logger.warning("no_valid_keys_in_announce", {
        from_system_id: systemId,
        from_physical_path: physicalPath,
        total_keys: keys.length,
        rejected_count: rejectedCount,
      });
      return;
    }

    logger.debug("adding_keys", {
      key_ids: validKeys.map((key) => (typeof key?.kid === "string" ? key.kid : "unknown")),
      source_system_id: systemId,
      from_physical_path: physicalPath,
      trace_id: currentTraceId(),
      origin,
      valid_count: validKeys.length,
      rejected_count: rejectedCount,
    });

    if (origin === DeliveryOriginType.LOCAL) {
      await this.keyStore.addKeys(validKeys as Array<JsonWebKey>, physicalPath);
      return;
    }

    const selfPhysicalPath = this.physicalPath;

    if (sid && !skipSidValidation) {
      let keyPath: string | null = null;

      if (origin === DeliveryOriginType.DOWNSTREAM) {
        keyPath = appendPath(selfPhysicalPath, systemId);
      } else if (origin === DeliveryOriginType.UPSTREAM) {
        keyPath = parentPath(selfPhysicalPath);
      } else if (origin === DeliveryOriginType.PEER) {
        keyPath = appendPath("/", systemId);
      }

      if (!keyPath) {
        throw new Error("Unable to determine expected SID for key announcement");
      }

      const expectedSid = secureDigest(keyPath);
      if (sid !== expectedSid) {
        throw new Error(`Invalid downstream sid: ${sid}`);
      }
    }

    if (origin === DeliveryOriginType.DOWNSTREAM) {
      const normalizedFramePath = normalizePhysicalPath(physicalPath);
      const expectedPrefix = `${appendPath(selfPhysicalPath, systemId)}/`;
      if (!`${normalizedFramePath}/`.startsWith(expectedPrefix)) {
        throw new Error(
          `Frame physical path ${normalizedFramePath} does not match expected prefix ${expectedPrefix}`
        );
      }
    }

    await this.keyStore.addKeys(validKeys as Array<JsonWebKey>, physicalPath);

    if (origin === DeliveryOriginType.DOWNSTREAM) {
      await this.announcePathKeys(validKeys, physicalPath);
    } else {
      logger.debug("skip_announcing_keys_to_upstream", {
        key_ids: validKeys.map((key) => (typeof key?.kid === "string" ? key.kid : "unknown")),
        from_physical_path: physicalPath,
        has_upstream: this.hasUpstream,
      });
    }
  }

  public async announceKeysToUpstream(): Promise<void> {
    if (!this.hasUpstream) {
      return;
    }

    logger.debug("reannouncing_keys_upstream");
    const selfPhysicalPath = this.physicalPath;
    const grouped = await this.keyStore.getKeysGroupedByPath();

    const tasks: Array<Promise<void>> = [];
    for (const [path, keys] of Object.entries(grouped)) {
      if (!path.startsWith(selfPhysicalPath)) {
        continue;
      }
      tasks.push(
        this.announcePathKeys(keys as Array<Record<string, unknown>>, path).catch((error) => {
          logger.error("announce_key_failed", { error });
        })
      );
    }

    await Promise.all(tasks);
    logger.debug("reannounce_keys_upstream_completed");
  }

  public async handleKeyRequest(options: {
    kid: string;
    fromSegment: string;
    physicalPath?: string;
    origin: DeliveryOriginType;
    correlationId?: string;
    originalClientSid?: string;
  }): Promise<void> {
    const { kid, fromSegment, physicalPath, origin, correlationId, originalClientSid } = options;

    logger.debug("handling_key_request", { kid, corr_id: correlationId });

    let key: KeyRecord | undefined;
    let keys: KeyRecord[] = [];

    try {
      key = await this.keyStore.getKey(kid);
      keys = [key];
    } catch (error) {
      if (!physicalPath) {
        throw error;
      }
      const fromPathKeys = await this.keyStore.getKeysForPath(physicalPath);
      keys = Array.from(fromPathKeys);
      key = keys[0];
      if (!key) {
        throw error;
      }
    }

    const envelopeFactory = ensureEnvelopeFactory(this.envelopeFactory);
    const physical =
      typeof key.physical_path === "string"
        ? key.physical_path
        : (physicalPath ?? this.physicalPath);

    const frame: KeyAnnounceFrame = {
      type: "KeyAnnounce",
      physicalPath: physical,
      keys: keys as Array<Record<string, unknown>>,
      created: new Date().toISOString(),
    };

    const envelopeOptions: { frame: KeyAnnounceFrame; corrId?: string } = { frame };
    if (correlationId) {
      envelopeOptions.corrId = correlationId;
    }

    const envelope = envelopeFactory.createEnvelope(envelopeOptions);

    const nodeId = this.nodeId;
    if (!nodeId) {
      throw new Error("Node ID not available - key manager not properly initialized");
    }

    const deliveryContext = localDeliveryContext(nodeId);
    if (typeof key.use === "string" && key.use === "enc") {
      deliveryContext.stickinessRequired = true;
      deliveryContext.stickySid = originalClientSid ?? undefined;
      logger.debug("key_announce_stickiness_set", {
        kid,
        corr_id: correlationId,
        key_use: key.use,
        original_client_sid: originalClientSid ?? null,
      });
    }

    if (origin === DeliveryOriginType.DOWNSTREAM) {
      const routingNode = ensureNode(
        this.routingNode,
        "Forward downstream not available - routing functionality not initialized"
      );
      if (!routingNode.forwardToRoute) {
        throw new Error("Routing node does not support forwardToRoute");
      }
      await routingNode.forwardToRoute(fromSegment, envelope, deliveryContext);
      return;
    }

    const node = ensureNode(this.node, "Node not available - key manager not properly initialized");
    await node.forwardUpstream(envelope, deliveryContext);
  }

  public async removeKeysForPath(physicalPath: string): Promise<number> {
    const removed = await this.keyStore.removeKeysForPath(physicalPath);
    logger.debug("removed_keys_for_path", {
      physical_path: physicalPath,
      removed_count: removed,
    });
    return removed;
  }

  public async getKeysForPath(physicalPath: string): Promise<Iterable<KeyRecord>> {
    return this.keyStore.getKeysForPath(physicalPath);
  }

  private get hasUpstream(): boolean {
    return this.node?.hasParent ?? false;
  }

  private get physicalPath(): string {
    return this.node?.physicalPath ?? "/";
  }

  private get nodeId(): string {
    return this.node?.id ?? "";
  }

  private get envelopeFactory(): EnvelopeFactory | null {
    return this.node?.envelopeFactory ?? null;
  }

  private async announcePathKeys(
    keys: Array<Record<string, unknown>>,
    fromPhysicalPath: string
  ): Promise<void> {
    const hasRoutingDestination = Boolean(this.routingNode?.forwardToPeers);
    if (!this.hasUpstream && !hasRoutingDestination) {
      logger.debug("skip_announcing_keys_no_destination", {
        key_ids: keys.map((key) => (typeof key?.kid === "string" ? key.kid : "unknown")),
        from_physical_path: fromPhysicalPath,
        has_upstream: this.hasUpstream,
        has_routing_node: this.routingNode !== null,
      });
      return;
    }

    logger.debug("announcing_keys_to_upstream", {
      key_ids: keys.map((key) => (typeof key?.kid === "string" ? key.kid : "unknown")),
      from_physical_path: fromPhysicalPath,
    });

    const envelopeFactory = ensureEnvelopeFactory(this.envelopeFactory);
    const frame: KeyAnnounceFrame = {
      type: "KeyAnnounce",
      physicalPath: fromPhysicalPath,
      keys,
      created: new Date().toISOString(),
    };

    const envelope = envelopeFactory.createEnvelope({ frame });

    if (this.hasUpstream) {
      const nodeId = this.nodeId;
      if (!nodeId) {
        throw new Error("Node ID not available - key manager not properly initialized");
      }
      const node = ensureNode(
        this.node,
        "Node not available - key manager not properly initialized"
      );
      await node.forwardUpstream(envelope, localDeliveryContext(nodeId));
    }

    const routingNode = this.routingNode;
    if (routingNode?.forwardToPeers) {
      const nodeId = this.nodeId;
      if (!nodeId) {
        throw new Error("Node ID not available - key manager not properly initialized");
      }
      await routingNode.forwardToPeers(
        envelope,
        undefined,
        undefined,
        localDeliveryContext(nodeId)
      );
    }
  }
}
