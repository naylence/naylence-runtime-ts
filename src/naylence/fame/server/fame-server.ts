import fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyListenOptions,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type HookHandlerDoneFunction,
} from 'fastify';
import { getLogger } from '../util/logging.js';
import {
  normalizeFameServerConfig,
  type FameServerClientConfig,
  type FameServerClientConfigInput,
  type FameServerConfig,
  type FameServerConfigInput,
  type FameServerRouteConfig,
} from './fame-server-config.js';

const logger = getLogger('naylence.fame.server.fame_server');

export interface CreateFameServerOptions {
  config?: FameServerConfigInput | null;
  fastifyOptions?: FastifyServerOptions;
  existingInstance?: FastifyInstance;
}

type CreateFameServerOptionsInput =
  | CreateFameServerOptions
  | (Record<string, unknown> & {
      config?: FameServerConfigInput | Record<string, unknown> | null;
      serverConfig?: FameServerConfigInput | Record<string, unknown> | null;
      server_config?: FameServerConfigInput | Record<string, unknown> | null;
      fastifyOptions?: FastifyServerOptions | Record<string, unknown> | null;
      fastify_options?: FastifyServerOptions | Record<string, unknown> | null;
      existingInstance?: FastifyInstance;
      existing_instance?: FastifyInstance;
    });

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
  optionsInput?: CreateFameServerOptionsInput
): FameFastifyServer {
  const options = normalizeCreateFameServerOptions(optionsInput);
  const config = normalizeFameServerConfig(options.config ?? undefined);

  const defaultTrustProxy = cloneTrustProxy(config.trustProxy);

  const routerOptions = {
    ...(options.fastifyOptions?.routerOptions ?? {}),
    caseSensitive:
      options.fastifyOptions?.routerOptions?.caseSensitive ?? false,
    maxParamLength:
      options.fastifyOptions?.routerOptions?.maxParamLength ??
      config.maxParamLength,
  };

  const fastifyOptions: FastifyServerOptions = {
    logger: options.fastifyOptions?.logger ?? false,
    disableRequestLogging:
      options.fastifyOptions?.disableRequestLogging ?? true,
    trustProxy: options.fastifyOptions?.trustProxy ?? defaultTrustProxy,
    bodyLimit: options.fastifyOptions?.bodyLimit ?? config.bodyLimitBytes,
    ajv: options.fastifyOptions?.ajv ?? {
      customOptions: { removeAdditional: 'all', useDefaults: true },
    },
    routerOptions,
  };

  const app = options.existingInstance ?? fastify(fastifyOptions);

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
    (
      _request: FastifyRequest,
      payload: string,
      done: (error: Error | null, body?: Record<string, string>) => void
    ) => {
      try {
        const params = new URLSearchParams(payload);
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

  app.addHook(
    'onRequest',
    (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction) => {
    requestStartTimes.set(request, Date.now());
    logger.debug('http_request_received', {
      request_id: request.id,
      method: request.method,
      url: request.url,
      remote_address: request.ip,
    });
      done();
    }
  );

  app.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
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
    }
  );

  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
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
    }
  );

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

      app.addHook('onClose', (_instance: FastifyInstance, done: HookHandlerDoneFunction) => {
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

function normalizeCreateFameServerOptions(
  optionsInput?: CreateFameServerOptionsInput | null
): CreateFameServerOptions {
  if (!optionsInput) {
    return {};
  }

  const source = optionsInput as Record<string, unknown>;

  const configInput =
    source.config ?? source.serverConfig ?? source.server_config ?? undefined;
  const normalizedConfig = normalizeFameServerConfigInputAliases(configInput);

  const fastifyOptionsInput =
    source.fastifyOptions ?? source.fastify_options ?? undefined;
  const normalizedFastifyOptions = normalizeFastifyOptionsInput(
    fastifyOptionsInput
  );

  const existingInstance = (source.existingInstance ??
    source.existing_instance) as FastifyInstance | undefined;

  const normalized: CreateFameServerOptions = {};

  if (normalizedConfig !== undefined) {
    normalized.config = normalizedConfig;
  }

  if (normalizedFastifyOptions !== undefined) {
    normalized.fastifyOptions = normalizedFastifyOptions;
  }

  if (existingInstance !== undefined) {
    normalized.existingInstance = existingInstance;
  }

  return normalized;
}

function normalizeFameServerConfigInputAliases(
  input?: FameServerConfigInput | Record<string, unknown> | null
): FameServerConfigInput | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const source = { ...(input as Record<string, unknown>) };

  if (!('basePath' in source) && 'base_path' in source) {
    source.basePath = source.base_path;
  }
  delete source.base_path;

  if (!('trustProxy' in source) && 'trust_proxy' in source) {
    source.trustProxy = source.trust_proxy;
  }
  delete source.trust_proxy;

  const numericAliasPairs: Array<[string, keyof FameServerConfigInput]> = [
    ['request_timeout_ms', 'requestTimeoutMs'],
    ['keep_alive_timeout_ms', 'keepAliveTimeoutMs'],
    ['headers_timeout_ms', 'headersTimeoutMs'],
    ['plugin_timeout_ms', 'pluginTimeoutMs'],
    ['body_limit_bytes', 'bodyLimitBytes'],
    ['max_param_length', 'maxParamLength'],
  ];

  for (const [alias, canonical] of numericAliasPairs) {
    if (!(canonical in source) && alias in source) {
      source[canonical] = source[alias];
    }
    delete source[alias];
  }

  if (!('enableIntrospection' in source) && 'enable_introspection' in source) {
    source.enableIntrospection = source.enable_introspection;
  }
  delete source.enable_introspection;

  if (!('defaultAudience' in source) && 'default_audience' in source) {
    source.defaultAudience = source.default_audience;
  }
  delete source.default_audience;

  const routesInput =
    source.routes ?? source.routeConfig ?? source.route_config ?? undefined;
  if (routesInput !== undefined) {
    const routes = normalizeRouteConfigAliases(routesInput);
    if (routes) {
      source.routes = routes;
    }
  }
  delete source.routeConfig;
  delete source.route_config;

  if (Array.isArray(source.clients)) {
    source.clients = source.clients
      .map((client) => normalizeClientConfigEntry(client))
      .filter((client): client is FameServerClientConfigInput => client !== undefined);
  }

  return source as FameServerConfigInput;
}

function normalizeRouteConfigAliases(
  input: unknown
): Partial<FameServerRouteConfig> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const source = { ...(input as Record<string, unknown>) };

  if (
    !('openIdConfiguration' in source) &&
    typeof source.open_id_configuration === 'string'
  ) {
    source.openIdConfiguration = source.open_id_configuration;
  }
  delete source.open_id_configuration;

  return source as Partial<FameServerRouteConfig>;
}

function normalizeClientConfigEntry(
  entry: unknown
): FameServerClientConfigInput | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const source = { ...(entry as Record<string, unknown>) };

  if (!('clientId' in source) && 'client_id' in source) {
    source.clientId = source.client_id;
  }
  delete source.client_id;

  if (!('clientSecret' in source) && 'client_secret' in source) {
    source.clientSecret = source.client_secret;
  }
  delete source.client_secret;

  return source as unknown as FameServerClientConfigInput;
}

function normalizeFastifyOptionsInput(
  input?: FastifyServerOptions | Record<string, unknown> | null
): FastifyServerOptions | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const source = { ...(input as Record<string, unknown>) };

  const optionAliasPairs: Array<[string, string]> = [
    ['disable_request_logging', 'disableRequestLogging'],
    ['trust_proxy', 'trustProxy'],
    ['body_limit', 'bodyLimit'],
  ];

  for (const [alias, canonical] of optionAliasPairs) {
    if (!(canonical in source) && alias in source) {
      source[canonical] = source[alias];
    }
    delete source[alias];
  }

  const routerOptionsInput =
    source.routerOptions ?? source.router_options ?? undefined;
  if (routerOptionsInput && typeof routerOptionsInput === 'object') {
    const routerSource = {
      ...(routerOptionsInput as Record<string, unknown>),
    };

    const routerAliasPairs: Array<[string, string]> = [
      ['case_sensitive', 'caseSensitive'],
      ['max_param_length', 'maxParamLength'],
    ];

    for (const [alias, canonical] of routerAliasPairs) {
      if (!(canonical in routerSource) && alias in routerSource) {
        routerSource[canonical] = routerSource[alias];
      }
      delete routerSource[alias];
    }

    source.routerOptions = routerSource as FastifyServerOptions['routerOptions'];
  }
  delete source.router_options;

  return source as FastifyServerOptions;
}
