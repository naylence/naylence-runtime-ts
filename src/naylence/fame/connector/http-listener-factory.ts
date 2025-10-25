import {
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
} from './transport-listener-factory.js';
import type { TransportListener } from './transport-listener.js';
import type { TransportListenerConfig } from './transport-listener-config.js';
import type { HttpServer } from './http-server.js';
import type { Authorizer } from '../security/auth/authorizer.js';
import { AuthorizerFactory } from '../security/auth/authorizer-factory.js';
import { safeImport } from '../util/lazy-import.js';
import type { NodeEventListener } from '../node/node-event-listener.js';

export interface HttpListenerFactoryConfig extends TransportListenerConfig {
  type: 'HttpListener';
  host?: string;
  port?: number;
  authorizer?: Record<string, unknown> | null;
}

export interface CreateHttpListenerOptions {
  httpServer?: HttpServer;
  authorizer?: Authorizer;
}

type DefaultHttpServerModule = typeof import('./default-http-server.js');
type HttpListenerModule = typeof import('./http-listener.js');

let defaultHttpServerModulePromise: Promise<DefaultHttpServerModule> | null =
  null;
function getDefaultHttpServerModule(): Promise<DefaultHttpServerModule> {
  if (!defaultHttpServerModulePromise) {
    defaultHttpServerModulePromise = safeImport(
      () => import('./default-http-server.js'),
      '@fastify/websocket'
    );
  }
  return defaultHttpServerModulePromise;
}

let httpListenerModulePromise: Promise<HttpListenerModule> | null = null;
function getHttpListenerModule(): Promise<HttpListenerModule> {
  if (!httpListenerModulePromise) {
    httpListenerModulePromise = safeImport(
      () => import('./http-listener.js'),
      'fastify'
    );
  }
  return httpListenerModulePromise;
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
  config?: HttpListenerFactoryConfig | Record<string, unknown> | null
): Required<Pick<HttpListenerFactoryConfig, 'host' | 'port'>> & {
  type: 'HttpListener';
  authorizer: Record<string, unknown> | null;
} {
  const record = (config ?? {}) as Record<string, unknown>;

  const hostValue =
    typeof record.host === 'string' && record.host.trim().length > 0
      ? record.host.trim()
      : '0.0.0.0';

  const rawPort = record.port;
  let portValue = 0;
  if (typeof rawPort === 'number' && Number.isFinite(rawPort)) {
    portValue = rawPort;
  } else if (typeof rawPort === 'string') {
    const parsed = Number.parseInt(rawPort.trim(), 10);
    if (Number.isFinite(parsed)) {
      portValue = parsed;
    }
  }

  const rawAuthorizer = record.authorizer ?? null;
  const authorizerValue =
    rawAuthorizer &&
    typeof rawAuthorizer === 'object' &&
    !Array.isArray(rawAuthorizer)
      ? (rawAuthorizer as Record<string, unknown>)
      : null;

  return {
    type: 'HttpListener',
    host: hostValue,
    port: portValue,
    authorizer: authorizerValue,
  };
}

export const FACTORY_META = {
  base: TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  key: 'HttpListener',
} as const;

export class HttpListenerFactory extends TransportListenerFactory<HttpListenerFactoryConfig> {
  public readonly type = 'HttpListener';
  public readonly isDefault = true;
  public readonly priority = 1000;

  public async create(
    config?: HttpListenerFactoryConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);

    const [firstArg, ...remainingArgs] = factoryArgs;
    const eventListeners = Array.isArray(firstArg)
      ? (firstArg as NodeEventListener[])
      : [];
    const optionsSource = Array.isArray(firstArg)
      ? (remainingArgs[0] ?? null)
      : (firstArg ?? null);
    const options = optionsSource as CreateHttpListenerOptions | null;

    const { HttpListener } = await getHttpListenerModule();

    const httpServer =
      options?.httpServer ?? (await this._createDefaultHttpServer(normalized));

    addServerEventListener(httpServer, eventListeners);

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
    normalized: Required<Pick<HttpListenerFactoryConfig, 'host' | 'port'>>
  ): Promise<HttpServer> {
    const { DefaultHttpServer } = await getDefaultHttpServerModule();
    return await DefaultHttpServer.getOrCreate({
      host: normalized.host,
      port: normalized.port,
    });
  }
}

export default HttpListenerFactory;
