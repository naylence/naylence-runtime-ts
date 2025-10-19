import fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
  type FastifyServerOptions,
} from 'fastify';
import { getLogger } from '../util/logging.js';
import {
  normalizeFameServerConfig,
  type FameServerClientConfig,
  type FameServerConfig,
  type FameServerConfigInput,
} from './fame-server-config.js';

const logger = getLogger('naylence.fame.server.fame_server');

export interface CreateFameServerOptions {
  config?: FameServerConfigInput | null;
  fastifyOptions?: FastifyServerOptions;
  existingInstance?: FastifyInstance;
}

export interface FameFastifyServer {
  readonly config: FameServerConfig;
  readonly app: FastifyInstance;
  start(options?: StartServerOptions): Promise<void>;
  stop(): Promise<void>;
  getAddress(): string | null;
  getClientById(clientId: string): FameServerClientConfig | undefined;
}

export interface StartServerOptions {
  signal?: AbortSignal;
  listen?: FastifyListenOptions;
}

export type FameServerRouteRegistrar = (
  instance: FastifyInstance,
  config: FameServerConfig
) => Promise<void> | void;

export function createFameFastifyServer(
  options?: CreateFameServerOptions
): FameFastifyServer {
  const config = normalizeFameServerConfig(options?.config ?? undefined);

  const defaultTrustProxy = cloneTrustProxy(config.trustProxy);

  const routerOptions = {
    ...(options?.fastifyOptions?.routerOptions ?? {}),
    caseSensitive:
      options?.fastifyOptions?.routerOptions?.caseSensitive ?? false,
    maxParamLength:
      options?.fastifyOptions?.routerOptions?.maxParamLength ??
      config.maxParamLength,
  };

  const fastifyOptions: FastifyServerOptions = {
    logger: options?.fastifyOptions?.logger ?? false,
    disableRequestLogging:
      options?.fastifyOptions?.disableRequestLogging ?? true,
    trustProxy: options?.fastifyOptions?.trustProxy ?? defaultTrustProxy,
    bodyLimit: options?.fastifyOptions?.bodyLimit ?? config.bodyLimitBytes,
    ajv: options?.fastifyOptions?.ajv ?? {
      customOptions: { removeAdditional: 'all', useDefaults: true },
    },
    routerOptions,
  };

  const app = options?.existingInstance ?? fastify(fastifyOptions);

  const maybePluginTimeout = app as {
    setPluginTimeout?: (timeout: number) => unknown;
  };
  if (typeof maybePluginTimeout.setPluginTimeout === 'function') {
    maybePluginTimeout.setPluginTimeout(config.pluginTimeoutMs);
  }

  // Configure low-level Node.js server timeouts for better parity with Python FastAPI defaults.
  const nodeServer = app.server;
  nodeServer.keepAliveTimeout = config.keepAliveTimeoutMs;
  nodeServer.headersTimeout = config.headersTimeoutMs;
  nodeServer.requestTimeout = config.requestTimeoutMs;

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, payload, done) => {
      try {
        const params = new URLSearchParams(payload as string);
        const result: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          result[key] = value;
        }
        done(null, result);
      } catch (error) {
        done(error as Error);
      }
    }
  );

  const requestStartTimes = new WeakMap<object, number>();

  app.addHook('onRequest', (request, _reply, done) => {
    requestStartTimes.set(request, Date.now());
    logger.debug('http_request_received', {
      request_id: request.id,
      method: request.method,
      url: request.url,
      remote_address: request.ip,
    });
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const startedAt = requestStartTimes.get(request);
    logger.debug('http_request_completed', {
      request_id: request.id,
      method: request.method,
      url: request.url,
      status_code: reply.statusCode,
      duration_ms:
        typeof startedAt === 'number' ? Date.now() - startedAt : null,
    });
    if (startedAt !== undefined) {
      requestStartTimes.delete(request);
    }
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error('http_request_error', {
      request_id: request.id,
      method: request.method,
      url: request.url,
      status_code: reply.statusCode,
      error: error instanceof Error ? error.message : String(error),
    });
    void reply.status(reply.statusCode >= 400 ? reply.statusCode : 500).send({
      error: 'internal_server_error',
      message: 'Unexpected server error',
    });
  });

  let listeningAddress: string | null = null;
  let abortCleanup: (() => void) | null = null;
  let started = false;

  async function start(options?: StartServerOptions): Promise<void> {
    if (started) {
      throw new Error('Fame Fastify server is already running');
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      throw new Error('Cannot start server, abort signal already triggered');
    }

    const listenOptions: FastifyListenOptions = {
      port: config.port,
      host: config.host,
      ...options?.listen,
    };

    listeningAddress = await app.listen(listenOptions);
    started = true;

    logger.info('fame_server_listening', {
      address: listeningAddress,
      host: listenOptions.host,
      port: listenOptions.port,
      base_path: config.basePath || '/',
    });

    if (signal) {
      const handleAbort = (): void => {
        logger.warning('fame_server_abort_signal_received');
        void stop().catch((error) => {
          logger.error('fame_server_stop_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      abortCleanup = () => {
        signal.removeEventListener('abort', handleAbort);
        abortCleanup = null;
      };

      app.addHook('onClose', (_instance, done) => {
        if (abortCleanup) {
          abortCleanup();
        }
        done();
      });
    }
  }

  async function stop(): Promise<void> {
    if (!started) {
      return;
    }

    if (abortCleanup) {
      abortCleanup();
    }

    await app.close();
    started = false;
    logger.info('fame_server_stopped', {
      previous_address: listeningAddress,
    });
    listeningAddress = null;
  }

  function getAddress(): string | null {
    return listeningAddress;
  }

  function getClientById(clientId: string): FameServerClientConfig | undefined {
    return config.clients.find((client) => client.id === clientId);
  }

  return {
    config,
    app,
    start,
    stop,
    getAddress,
    getClientById,
  };
}

export async function registerFameServerRoutes(
  server: FameFastifyServer,
  registrar: FameServerRouteRegistrar
): Promise<void> {
  const prefix = server.config.basePath;
  if (!prefix) {
    await registrar(server.app, server.config);
    return;
  }

  await server.app.register(
    async (scopedInstance) => {
      await registrar(scopedInstance, server.config);
    },
    { prefix }
  );
}

function cloneTrustProxy(
  value: FameServerConfig['trustProxy']
): boolean | string | string[] {
  if (Array.isArray(value)) {
    return Array.from(value);
  }
  return value as string | boolean;
}
