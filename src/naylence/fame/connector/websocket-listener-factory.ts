import type { TransportListener } from './transport-listener.js';
import {
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
} from './transport-listener-factory.js';
import type { TransportListenerConfig } from './transport-listener-config.js';
import type { Authorizer } from '../security/auth/authorizer.js';
import { AuthorizerFactory } from '../security/auth/authorizer-factory.js';
import { safeImport } from '../util/lazy-import.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import type { HttpServer } from './http-server.js';

export interface WebSocketListenerFactoryConfig
  extends TransportListenerConfig {
  type: 'WebSocketListener';
  host?: string;
  port?: number;
  authorizer?: Record<string, unknown> | null;
}

const ENV_WEBSOCKET_LISTENER_PORT = 'FAME_WEBSOCKET_LISTENER_PORT';

type DefaultHttpServerModule = typeof import('./default-http-server.js');
type WebSocketListenerModule = typeof import('./websocket-listener.js');

let defaultHttpServerModulePromise: Promise<DefaultHttpServerModule> | null =
  null;
let webSocketListenerModulePromise: Promise<WebSocketListenerModule> | null =
  null;

function getWebSocketListenerModule(): Promise<WebSocketListenerModule> {
  if (!webSocketListenerModulePromise) {
    webSocketListenerModulePromise = safeImport(
      () => import('./websocket-listener.js'),
      'websocket listener implementation',
      {
        helpMessage:
          'Failed to load the WebSocket listener implementation. Install optional transport dependencies.',
      }
    );
  }
  return webSocketListenerModulePromise;
}

function getDefaultHttpServerModule(): Promise<DefaultHttpServerModule> {
  if (!defaultHttpServerModulePromise) {
    defaultHttpServerModulePromise = safeImport(
      () => import('./default-http-server.js'),
      'fastify/@fastify/websocket'
    );
  }
  return defaultHttpServerModulePromise;
}

function addServerEventListener(
  server: HttpServer | null | undefined,
  listeners: NodeEventListener[]
): void {
  if (!server || !Array.isArray(listeners)) {
    return;
  }

  const candidate = server as unknown;
  if (!isNodeEventListener(candidate)) {
    return;
  }

  const listener = candidate as NodeEventListener;
  if (!listeners.includes(listener)) {
    listeners.push(listener);
  }
}

function isNodeEventListener(value: unknown): value is NodeEventListener {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as NodeEventListener).priority === 'number'
  );
}

function normalizeConfig(
  config?: WebSocketListenerFactoryConfig | Record<string, unknown> | null
): Required<Pick<WebSocketListenerFactoryConfig, 'host' | 'port'>> & {
  type: 'WebSocketListener';
  authorizer: Record<string, unknown> | null;
} {
  const record = (config ?? {}) as Record<string, unknown>;

  const hostValue =
    typeof record.host === 'string' && record.host.trim().length > 0
      ? record.host
      : '0.0.0.0';

  let portValue: number | undefined;
  if (typeof record.port === 'number' && Number.isFinite(record.port)) {
    portValue = record.port;
  } else {
    const envPort =
      typeof process !== 'undefined'
        ? process.env?.[ENV_WEBSOCKET_LISTENER_PORT]
        : undefined;
    const parsedEnvPort = envPort ? Number(envPort) : NaN;
    portValue = Number.isFinite(parsedEnvPort) ? parsedEnvPort : 0;
  }

  const rawAuthorizer = record.authorizer ?? null;
  const authorizerValue =
    rawAuthorizer &&
    typeof rawAuthorizer === 'object' &&
    !Array.isArray(rawAuthorizer)
      ? (rawAuthorizer as Record<string, unknown>)
      : null;

  return {
    type: 'WebSocketListener',
    host: hostValue,
    port: portValue ?? 0,
    authorizer: authorizerValue,
  };
}

export const FACTORY_META = {
  base: TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  key: 'WebSocketListener',
} as const;

export class WebSocketListenerFactory extends TransportListenerFactory<WebSocketListenerFactoryConfig> {
  public readonly type = 'WebSocketListener';
  public readonly isDefault = true;
  public readonly priority = 900;

  public async create(
    config?: WebSocketListenerFactoryConfig | Record<string, unknown> | null,

    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);

    const [{ WebSocketListener }, { DefaultHttpServer }] = await Promise.all([
      getWebSocketListenerModule(),
      getDefaultHttpServerModule(),
    ]);

    const [firstArg, ...remainingArgs] = factoryArgs;
    const eventListeners = Array.isArray(firstArg)
      ? (firstArg as NodeEventListener[])
      : [];

    const options = (
      Array.isArray(firstArg) ? remainingArgs[0] : (firstArg ?? null)
    ) as {
      authorizer?: Authorizer;
    } | null;
    const providedAuthorizer = options?.authorizer ?? null;

    let authorizer = providedAuthorizer ?? null;
    if (!authorizer && normalized.authorizer) {
      authorizer =
        (await AuthorizerFactory.createAuthorizer(normalized.authorizer, {
          validate: false,
        })) ?? null;
    }

    const httpServer = await DefaultHttpServer.getOrCreate({
      host: normalized.host,
      port: normalized.port,
    });

    addServerEventListener(httpServer, eventListeners);

    return new WebSocketListener({
      httpServer,
      authorizer: authorizer ?? undefined,
    });
  }
}

export default WebSocketListenerFactory;
