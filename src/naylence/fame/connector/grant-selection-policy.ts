import type { NodeAttachFrame } from "naylence-core";

import type { RoutingNodeLike } from "../node/routing-node-like.js";
import type { ConnectionGrant } from "../grants/connection-grant.js";
import {
  HTTP_CONNECTION_GRANT_TYPE,
  type HttpConnectionGrant,
  type HttpConnectionGrantLike,
  httpGrantToConnectorConfig,
  normalizeHttpConnectionGrant,
} from "../grants/http-connection-grant.js";
import {
  WEBSOCKET_CONNECTION_GRANT_TYPE,
  type WebSocketConnectionGrant,
  type WebSocketConnectionGrantLike,
  normalizeWebSocketConnectionGrant,
  websocketGrantToConnectorConfig,
} from "../grants/websocket-connection-grant.js";
import type { ConnectorConfig } from "./connector-config.js";
import { getLogger } from "../util/logging.js";

const logger = getLogger("grant-selection-policy");

function isSerializedGrant(value: unknown): value is SerializedGrant {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export enum ConnectorType {
  HTTP_STATELESS = "HttpStatelessConnector",
  WEBSOCKET_STATELESS = "WebSocketStatelessConnector",
  WEBSOCKET = "WebSocketConnector",
}

export interface SerializedGrant extends Record<string, unknown> {
  type?: string;
}

export interface GrantSelectionContextInit {
  childId: string;
  attachFrame: NodeAttachFrame;
  callbackGrantType: string;
  node: RoutingNodeLike;
}

export class GrantSelectionContext {
  public readonly childId: string;
  public readonly attachFrame: NodeAttachFrame;
  public readonly callbackGrantType: string;
  public readonly node: RoutingNodeLike;

  constructor(init: GrantSelectionContextInit) {
    this.childId = init.childId;
    this.attachFrame = init.attachFrame;
    this.callbackGrantType = init.callbackGrantType;
    this.node = init.node;
  }

  get clientSupportedCallbackGrants(): SerializedGrant[] {
  const callbackGrants = this.attachFrame.callbackGrants as unknown[] | undefined;
    if (!callbackGrants || callbackGrants.length === 0) {
      return [];
    }

    return callbackGrants
      .map((grant): SerializedGrant => {
        if (isSerializedGrant(grant)) {
          return { ...grant };
        }
        return {} as SerializedGrant;
      })
      .filter((grant): grant is SerializedGrant => Object.keys(grant).length > 0);
  }
}

export class GrantSelectionResult<TGrant extends ConnectionGrant = ConnectionGrant> {
  constructor(
    public readonly grant: TGrant,
    public readonly selectionReason: string,
    public readonly fallbackUsed: boolean = false
  ) {}

  toString(): string {
    return `GrantSelectionResult(type=${this.grant.type}, reason="${this.selectionReason}", fallback=${this.fallbackUsed})`;
  }
}

export interface GrantSelectionStrategy {
  selectCallbackGrant(context: GrantSelectionContext): GrantSelectionResult | null;
}

type TypedGrant = ConnectionGrant & {
  toConnectorConfig?: () => ConnectorConfig;
};

function createGrantFromRecord(serialized: SerializedGrant): TypedGrant | null {
  switch (serialized.type) {
    case HTTP_CONNECTION_GRANT_TYPE:
      return createHttpGrant(serialized as HttpConnectionGrantLike);
    case WEBSOCKET_CONNECTION_GRANT_TYPE:
      return createWebSocketGrant(serialized as WebSocketConnectionGrantLike);
    default:
      return null;
  }
}

function createHttpGrant(serialized: HttpConnectionGrantLike): TypedGrant | null {
  try {
    const normalized = normalizeHttpConnectionGrant(serialized);
    const grant: HttpConnectionGrant & { toConnectorConfig: () => ConnectorConfig } = {
      ...normalized,
      toConnectorConfig: () => httpGrantToConnectorConfig(serialized),
    };
    return grant;
  } catch (error) {
    logger.debug("grant_selection_http_normalization_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function createWebSocketGrant(serialized: WebSocketConnectionGrantLike): TypedGrant | null {
  try {
    const normalized = normalizeWebSocketConnectionGrant(serialized);
    const grant: WebSocketConnectionGrant & { toConnectorConfig: () => ConnectorConfig } = {
      ...normalized,
      toConnectorConfig: () => websocketGrantToConnectorConfig(serialized),
    };
    return grant;
  } catch (error) {
    logger.debug("grant_selection_websocket_normalization_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

class PreferSameTypeStrategy implements GrantSelectionStrategy {
  selectCallbackGrant(context: GrantSelectionContext): GrantSelectionResult | null {
    const targetType = context.callbackGrantType;

    for (const serialized of context.clientSupportedCallbackGrants) {
      if (serialized.type !== targetType) {
        continue;
      }

      const grant = createGrantFromRecord(serialized);
      if (!grant) {
        continue;
      }

      return new GrantSelectionResult(grant, `Matching inbound connector type: ${targetType}`);
    }

    return null;
  }
}

class PreferHttpStrategy implements GrantSelectionStrategy {
  selectCallbackGrant(context: GrantSelectionContext): GrantSelectionResult | null {
    for (const serialized of context.clientSupportedCallbackGrants) {
      if (serialized.type !== HTTP_CONNECTION_GRANT_TYPE) {
        continue;
      }

      try {
        const normalized = normalizeHttpConnectionGrant(serialized as HttpConnectionGrantLike);
        const grant: HttpConnectionGrant & { toConnectorConfig: () => ConnectorConfig } = {
          ...normalized,
          toConnectorConfig: () =>
            httpGrantToConnectorConfig(serialized as HttpConnectionGrantLike),
        };
        return new GrantSelectionResult(grant, "Preferred HTTP connector type", true);
      } catch (error) {
        logger.debug("grant_selection_prefer_http_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }
}

class ClientPreferenceStrategy implements GrantSelectionStrategy {
  selectCallbackGrant(context: GrantSelectionContext): GrantSelectionResult | null {
    const [first] = context.clientSupportedCallbackGrants;
    if (!first) {
      return null;
    }

    const grant = createGrantFromRecord(first);
    if (grant) {
      return new GrantSelectionResult(
        grant,
        `Client's first preference: ${first.type ?? "unknown"}`,
        true
      );
    }

    return null;
  }
}

export class GrantSelectionPolicy {
  private readonly _strategies: GrantSelectionStrategy[];

  constructor(strategies?: GrantSelectionStrategy[]) {
    this._strategies = strategies ?? [
      new PreferSameTypeStrategy(),
      new PreferHttpStrategy(),
      new ClientPreferenceStrategy(),
    ];
  }

  selectCallbackGrant(context: GrantSelectionContext): GrantSelectionResult {
    logger.debug("grant_selection_start", {
      child: context.childId,
      inboundType: context.callbackGrantType,
      clientGrants: context.clientSupportedCallbackGrants.map((grant) => grant.type),
    });

    for (const strategy of this._strategies) {
      const result = strategy.selectCallbackGrant(context);
      if (!result) {
        continue;
      }

      logger.debug("grant_selection_success", {
        child: context.childId,
        selectedType: result.grant.type,
        strategy: strategy.constructor.name,
        reason: result.selectionReason,
        fallback: result.fallbackUsed,
      });
      return result;
    }

    const supportedTypes = context.clientSupportedCallbackGrants.map((grant) => grant.type);
    logger.warning("grant_selection_failed", {
      child: context.childId,
      clientConnectors: supportedTypes,
      inboundType: context.callbackGrantType,
      reason: "No matching strategy found",
    });

    throw new Error(
      `No suitable connector found for child ${context.childId}. Client supports: ${supportedTypes}, inbound type: ${context.callbackGrantType}`
    );
  }
}

export const defaultGrantSelectionPolicy = new GrantSelectionPolicy();
