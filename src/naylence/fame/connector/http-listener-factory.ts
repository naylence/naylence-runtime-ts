import { registerFactory } from "naylence-factory";

import {
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
} from "./transport-listener-factory.js";
import type { TransportListener } from "./transport-listener.js";
import type { TransportListenerConfig } from "./transport-listener-config.js";
import type { HttpServer } from "./http-server.js";
import type { Authorizer } from "../security/auth/authorizer.js";
import { AuthorizerFactory } from "../security/auth/authorizer-factory.js";
import { safeImport } from "../util/lazy-import.js";

export interface HttpListenerFactoryConfig extends TransportListenerConfig {
  type: "HttpListener";
  host?: string;
  port?: number;
  authorizer?: Record<string, unknown> | null;
}

export interface CreateHttpListenerOptions {
  httpServer?: HttpServer;
  authorizer?: Authorizer;
}

type DefaultHttpServerModule = typeof import("./default-http-server.js");
type HttpListenerModule = typeof import("./http-listener.js");

let defaultHttpServerModulePromise: Promise<DefaultHttpServerModule> | null = null;
function getDefaultHttpServerModule(): Promise<DefaultHttpServerModule> {
  if (!defaultHttpServerModulePromise) {
    defaultHttpServerModulePromise = safeImport(
      () => import("./default-http-server.js"),
      "@fastify/websocket"
    );
  }
  return defaultHttpServerModulePromise;
}

let httpListenerModulePromise: Promise<HttpListenerModule> | null = null;
function getHttpListenerModule(): Promise<HttpListenerModule> {
  if (!httpListenerModulePromise) {
    httpListenerModulePromise = safeImport(
      () => import("./http-listener.js"),
      "fastify"
    );
  }
  return httpListenerModulePromise;
}

function normalizeConfig(
  config?: HttpListenerFactoryConfig | Record<string, unknown> | null
): Required<Pick<HttpListenerFactoryConfig, "host" | "port">> & {
  type: "HttpListener";
  authorizer: Record<string, unknown> | null;
} {
  const record = (config ?? {}) as Record<string, unknown>;

  const hostValue =
    typeof record.host === "string" && record.host.trim().length > 0 ? record.host : "0.0.0.0";
  const portValue =
    typeof record.port === "number" && Number.isFinite(record.port) ? record.port : 0;

  const rawAuthorizer = record.authorizer ?? null;
  const authorizerValue =
    rawAuthorizer && typeof rawAuthorizer === "object" && !Array.isArray(rawAuthorizer)
      ? (rawAuthorizer as Record<string, unknown>)
      : null;

  return {
    type: "HttpListener",
    host: hostValue,
    port: portValue,
    authorizer: authorizerValue,
  };
}

export class HttpListenerFactory extends TransportListenerFactory<HttpListenerFactoryConfig> {
  public readonly type = "HttpListener";
  public readonly isDefault = true;
  public readonly priority = 1000;

  public async create(
    config?: HttpListenerFactoryConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);

    const options = (factoryArgs[0] ?? null) as CreateHttpListenerOptions | null;

    const { HttpListener } = await getHttpListenerModule();

    const httpServer = options?.httpServer ?? (await this._createDefaultHttpServer(normalized));

    let authorizer = options?.authorizer ?? null;
    if (!authorizer && normalized.authorizer) {
      authorizer =
        (await AuthorizerFactory.createAuthorizer(normalized.authorizer, {
          validate: false,
        })) ?? null;
    }

    return new HttpListener({
      httpServer,
      ...(authorizer ? { authorizer } : {}),
    });
  }

  private async _createDefaultHttpServer(
    normalized: Required<Pick<HttpListenerFactoryConfig, "host" | "port">>
  ): Promise<HttpServer> {
    const { DefaultHttpServer } = await getDefaultHttpServerModule();
    return await DefaultHttpServer.getOrCreate({
      host: normalized.host,
      port: normalized.port,
    });
  }
}

registerFactory<TransportListener, HttpListenerFactoryConfig>(
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  "HttpListener",
  HttpListenerFactory,
  { isDefault: true, priority: 1000 }
);
