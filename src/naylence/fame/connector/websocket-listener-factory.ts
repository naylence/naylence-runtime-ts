import { registerFactory } from "naylence-factory";

import type { TransportListener } from "./transport-listener.js";
import {
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
} from "./transport-listener-factory.js";
import type { TransportListenerConfig } from "./transport-listener-config.js";
import { DefaultHttpServer } from "./default-http-server.js";
import { WebSocketListener } from "./websocket-listener.js";
import type { Authorizer } from "../security/auth/authorizer.js";
import { AuthorizerFactory } from "../security/auth/authorizer-factory.js";

export interface WebSocketListenerFactoryConfig extends TransportListenerConfig {
  type: "WebSocketListener";
  host?: string;
  port?: number;
  authorizer?: Record<string, unknown> | null;
}

const ENV_WEBSOCKET_LISTENER_PORT = "FAME_WEBSOCKET_LISTENER_PORT";

function normalizeConfig(
  config?: WebSocketListenerFactoryConfig | Record<string, unknown> | null
): Required<Pick<WebSocketListenerFactoryConfig, "host" | "port">> & {
  type: "WebSocketListener";
  authorizer: Record<string, unknown> | null;
} {
  const record = (config ?? {}) as Record<string, unknown>;

  const hostValue =
    typeof record.host === "string" && record.host.trim().length > 0 ? record.host : "0.0.0.0";

  let portValue: number | undefined;
  if (typeof record.port === "number" && Number.isFinite(record.port)) {
    portValue = record.port;
  } else {
    const envPort =
      typeof process !== "undefined" ? process.env?.[ENV_WEBSOCKET_LISTENER_PORT] : undefined;
    const parsedEnvPort = envPort ? Number(envPort) : NaN;
    portValue = Number.isFinite(parsedEnvPort) ? parsedEnvPort : 0;
  }

  const rawAuthorizer = record.authorizer ?? null;
  const authorizerValue =
    rawAuthorizer && typeof rawAuthorizer === "object" && !Array.isArray(rawAuthorizer)
      ? (rawAuthorizer as Record<string, unknown>)
      : null;

  return {
    type: "WebSocketListener",
    host: hostValue,
    port: portValue ?? 0,
    authorizer: authorizerValue,
  };
}

export class WebSocketListenerFactory extends TransportListenerFactory<WebSocketListenerFactoryConfig> {
  public readonly type = "WebSocketListener";
  public readonly isDefault = true;
  public readonly priority = 900;

  public async create(
    config?: WebSocketListenerFactoryConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);

    const options = (factoryArgs[0] ?? null) as { authorizer?: Authorizer } | null;
    const providedAuthorizer = options?.authorizer ?? null;

    let authorizer = providedAuthorizer ?? null;
    if (!authorizer && normalized.authorizer) {
      authorizer =
        (await AuthorizerFactory.createAuthorizer(normalized.authorizer, { validate: false })) ??
        null;
    }

    const httpServer = await DefaultHttpServer.getOrCreate({
      host: normalized.host,
      port: normalized.port,
    });

    return new WebSocketListener({ httpServer, authorizer: authorizer ?? undefined });
  }
}

registerFactory<TransportListener, WebSocketListenerFactoryConfig>(
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  "WebSocketListener",
  WebSocketListenerFactory,
  { isDefault: true, priority: 900 }
);
