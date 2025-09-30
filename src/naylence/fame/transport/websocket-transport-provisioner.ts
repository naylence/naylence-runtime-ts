import { registerFactory } from "naylence-factory";
import type { NodeHelloFrame } from "naylence-core";

import { GRANT_PURPOSE_NODE_ATTACH } from "../grants/grant.js";
import {
  WEBSOCKET_CONNECTION_GRANT_TYPE,
  normalizeWebSocketConnectionGrant,
  type WebSocketConnectionGrant,
} from "../grants/websocket-connection-grant.js";
import type { StaticTokenProviderConfig } from "../security/auth/static-token-provider-factory.js";
import type { WebSocketSubprotocolAuthInjectionConfig } from "../security/auth/websocket-subprotocol-auth-injection-strategy-factory.js";
import type { PlacementDecision } from "../placement/node-placement-strategy.js";
import {
  TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE,
  TransportProvisionerFactory,
  type TransportProvisioner,
  type TransportProvisionerConfig,
  type TransportProvisionResult,
} from "./transport-provisioner.js";

export interface WebSocketTransportProvisionerOptions {
  url: string;
  ttlSec?: number;
}

export interface WebSocketTransportProvisionerConfig extends TransportProvisionerConfig {
  type: "WebSocketTransportProvisioner";
  url: string;
  ttlSec?: number;
  ttl_sec?: number;
}

export class WebSocketTransportProvisioner implements TransportProvisioner {
  public static readonly TRANSPORT_TYPE = "websocket";

  private readonly url: string;
  private readonly ttlSec: number | undefined;

  public constructor(options: WebSocketTransportProvisionerOptions) {
    this.url = options.url;
    this.ttlSec = options.ttlSec;
  }

  public async provision(
    _decision: PlacementDecision,
    hello: NodeHelloFrame,
    _fullMetadata: Record<string, unknown>,
    attachToken?: string | null
  ): Promise<TransportProvisionResult> {
    const supportedTransports = hello.supportedTransports;
    if (Array.isArray(supportedTransports) && supportedTransports.length > 0) {
      const hasWebSocket = supportedTransports.includes(
        WebSocketTransportProvisioner.TRANSPORT_TYPE
      );
      if (!hasWebSocket) {
        throw new Error(`Unsupported transports: ${supportedTransports.join(", ")}`);
      }
    }

    let authConfig: WebSocketSubprotocolAuthInjectionConfig | undefined;
    if (attachToken) {
      const tokenProviderConfig: StaticTokenProviderConfig = {
        type: "StaticTokenProvider",
        token: attachToken,
      };

      authConfig = {
        type: "WebSocketSubprotocolAuth",
        tokenProvider: tokenProviderConfig,
      };
    }

    const grant: WebSocketConnectionGrant = normalizeWebSocketConnectionGrant({
      type: WEBSOCKET_CONNECTION_GRANT_TYPE,
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      url: this.url,
      auth: authConfig,
    });

    const result: TransportProvisionResult = {
      connectionGrant: grant,
      cleanupHandle: null,
    };

    if (this.ttlSec !== undefined) {
      result.metadata = {
        ...(result.metadata ?? {}),
        ttlSec: this.ttlSec,
      };
    }

    return result;
  }

  public async deprovision(_cleanupHandle?: string | null): Promise<void> {
    // No-op for stateless WebSocket transport provisioners
  }
}

export class WebSocketTransportProvisionerFactory extends TransportProvisionerFactory<WebSocketTransportProvisionerConfig> {
  public readonly type = "WebSocketTransportProvisioner";
  public readonly isDefault = true;

  public async create(
    config?: WebSocketTransportProvisionerConfig | Record<string, unknown> | null
  ): Promise<TransportProvisioner> {
    const options = normalizeConfig(config);
    return new WebSocketTransportProvisioner(options);
  }
}

function normalizeConfig(
  config?: WebSocketTransportProvisionerConfig | Record<string, unknown> | null
): WebSocketTransportProvisionerOptions {
  if (!config) {
    throw new Error("WebSocketTransportProvisioner requires configuration");
  }

  const candidate = config as Record<string, unknown>;
  const typeValue = typeof candidate.type === "string" ? candidate.type : undefined;
  if (typeValue !== "WebSocketTransportProvisioner") {
    throw new Error(
      `WebSocketTransportProvisionerFactory expects type "WebSocketTransportProvisioner", got "${typeValue ?? "undefined"}"`
    );
  }

  const urlValue = candidate.url;
  if (typeof urlValue !== "string" || urlValue.trim().length === 0) {
    throw new Error(
      'WebSocketTransportProvisioner configuration must include a non-empty "url" string'
    );
  }

  const ttlCandidate = candidate.ttlSec ?? candidate.ttl_sec;

  const options: WebSocketTransportProvisionerOptions = {
    url: urlValue.trim(),
  };

  if (typeof ttlCandidate === "number" && Number.isFinite(ttlCandidate)) {
    options.ttlSec = ttlCandidate;
  }

  return options;
}

registerFactory<TransportProvisioner, WebSocketTransportProvisionerConfig>(
  TRANSPORT_PROVISIONER_FACTORY_BASE_TYPE,
  "WebSocketTransportProvisioner",
  WebSocketTransportProvisionerFactory,
  {
    isDefault: true,
  }
);
