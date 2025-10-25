import type { AddressInfo } from 'node:net';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

jest.mock('@fastify/websocket', () => jest.fn());

type MockRegistration = {
  plugin: unknown;
  options?: unknown;
};

type MockContentTypeParser = (
  req: FastifyRequest,
  payload: Buffer
) => Promise<Buffer>;

type MockFastifyInstance = {
  registrations: MockRegistration[];
  register: jest.Mock<Promise<void>, any>;
  listen: jest.Mock<Promise<unknown>, any>;
  close: jest.Mock<Promise<void>, any>;
  ready: jest.Mock<Promise<void>, any>;
  addContentTypeParser: jest.Mock<
    void,
    [string, { parseAs: string }, MockContentTypeParser]
  >;
  server: {
    address: jest.Mock<unknown, []>;
    unref?: jest.Mock<void, []>;
  };
};

type FastifyMockWithControls = jest.MockedFunction<
  () => MockFastifyInstance
> & {
  prepare(instance: MockFastifyInstance): void;
  resetMock(): void;
};

type FastifyInstanceConfig = {
  addressValue?: unknown;
  listenResult?: unknown;
  includeUnref?: boolean;
};

jest.mock('fastify', () => {
  const instances: MockFastifyInstance[] = [];
  const fastifyFn = jest.fn(() => {
    const next = instances.shift();
    if (!next) {
      throw new Error('No mock Fastify instance prepared');
    }
    return next;
  }) as unknown as FastifyMockWithControls;
  fastifyFn.prepare = (instance: MockFastifyInstance) => {
    instances.push(instance);
  };
  fastifyFn.resetMock = () => {
    instances.length = 0;
    fastifyFn.mockClear();
  };
  return {
    __esModule: true,
    default: fastifyFn,
  };
});

const websocketPluginMock = jest.requireMock('@fastify/websocket') as jest.Mock;
const { default: fastifyMock } = jest.requireMock('fastify') as {
  default: FastifyMockWithControls;
};

const createFastifyInstance = (
  config: FastifyInstanceConfig = {}
): MockFastifyInstance => {
  const registrations: MockRegistration[] = [];
  const server: MockFastifyInstance['server'] = {
    address: jest.fn(() => {
      if (typeof config.addressValue === 'function') {
        return (config.addressValue as () => unknown)();
      }
      if (config.addressValue !== undefined) {
        return config.addressValue;
      }
      return { address: '::', port: 3210 } as AddressInfo;
    }),
  };

  if (config.includeUnref !== false) {
    server.unref = jest.fn();
  }

  return {
    registrations,
    register: jest.fn(
      async (plugin: unknown, options?: Record<string, unknown>) => {
        registrations.push({ plugin, options });
      }
    ),
    addContentTypeParser: jest.fn(),
    listen: jest.fn(async ({ host, port }: { host: string; port: number }) => {
      void host;
      void port;
      return config.listenResult !== undefined
        ? config.listenResult
        : 'http://0.0.0.0:0';
    }),
    close: jest.fn(async () => {}),
    ready: jest.fn(async () => {}),
    server,
  };
};

const getRegistrationPlugins = (instance: MockFastifyInstance) =>
  instance.registrations.map((entry) => entry.plugin);

import { DefaultHttpServer } from '../default-http-server.js';

describe('DefaultHttpServer', () => {
  beforeEach(async () => {
    websocketPluginMock.mockReset();
    fastifyMock.resetMock();
    await DefaultHttpServer.shutdownAll();
  });

  afterEach(async () => {
    await DefaultHttpServer.shutdownAll();
    fastifyMock.resetMock();
  });

  it('registers with lowest node event listener priority', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '0.0.0.0',
      port: 0,
    });

    expect(server.priority).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('starts automatically during node initialization', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '0.0.0.0',
      port: 0,
    });

    expect(server.isRunning).toBe(false);

    await server.onNodeInitialized({} as any);

    expect(instance.listen).toHaveBeenCalledTimes(1);
    expect(server.isRunning).toBe(true);
  });

  it('starts once, loads core plugins, and tracks actual base url', async () => {
    const instance = createFastifyInstance({
      addressValue: {
        address: '::',
        port: 4444,
        family: 'IPv6',
      } as AddressInfo,
    });
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '127.0.0.1',
      port: 8080,
    });

    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBe(8080);
    expect(server.fastifyInstance).toBe(instance);
    expect(server.isRunning).toBe(false);
    expect(server.actualBaseUrl).toBeNull();

    await server.start();

    expect(instance.listen).toHaveBeenCalledTimes(1);
    expect(instance.listen).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 8080,
    });
    expect(getRegistrationPlugins(instance)[0]).toBe(websocketPluginMock);
    expect(instance.registrations[0]?.options).toEqual({
      options: { maxPayload: 1024 * 1024, perMessageDeflate: false },
    });
    expect(instance.addContentTypeParser).toHaveBeenCalledTimes(1);
    expect(instance.addContentTypeParser).toHaveBeenCalledWith(
      'application/octet-stream',
      { parseAs: 'buffer' },
      expect.any(Function)
    );
    const handler = instance.addContentTypeParser.mock
      .calls[0]?.[2] as MockContentTypeParser;
    expect(handler).toBeDefined();
    const payload = Buffer.from('payload');
    const result = await handler({} as FastifyRequest, payload);
    expect(result).toBe(payload);
    expect(server.actualBaseUrl).toBe('http://127.0.0.1:4444');
    expect(server.isRunning).toBe(true);

    await server.start();
    expect(instance.listen).toHaveBeenCalledTimes(1);
    expect(instance.server.unref).toHaveBeenCalledTimes(1);
  });

  it('derives actual address from listen return when server address is missing', async () => {
    const instance = createFastifyInstance({
      addressValue: null,
      listenResult: 'http://service.local:4321',
    });
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '0.0.0.0',
      port: 0,
    });

    await server.start();

    expect(server.actualHost).toBe('service.local');
    expect(server.actualPort).toBe(4321);
    expect(server.actualBaseUrl).toBe('http://service.local:4321');
  });

  it('derives address when listen returns a URL object', async () => {
    const instance = createFastifyInstance({
      addressValue: null,
      listenResult: new URL('http://object.local:6543'),
    });
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '0.0.0.0',
      port: 0,
    });

    await server.start();

    expect(server.actualHost).toBe('object.local');
    expect(server.actualPort).toBe(6543);
  });

  it('falls back to configured host and port when address resolution fails', async () => {
    const instance = createFastifyInstance({
      addressValue: 'not-a-url',
      listenResult: 'bogus',
      includeUnref: false,
    });
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '0.0.0.0',
      port: 9001,
    });
    await server.start();

    expect(server.actualHost).toBe('0.0.0.0');
    expect(server.actualPort).toBe(9001);
    expect(server.actualBaseUrl).toBe('http://0.0.0.0:9001');
    expect(instance.server.unref).toBeUndefined();
  });

  it('returns null base url when host is known but port is missing', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '2.2.2.2',
      port: 8800,
    });

    const internal = server as unknown as {
      _actualHost: string | null;
      _actualPort: number | null;
    };
    internal._actualHost = 'resolved';
    internal._actualPort = null;

    expect(server.actualBaseUrl).toBeNull();
  });

  it('includes routers with options without starting automatically', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '1.2.3.4',
      port: 7000,
    });

    const router: FastifyPluginAsync = jest.fn(async () => {});

    await server.includeRouter(router, { prefix: '/api' });

    expect(instance.listen).not.toHaveBeenCalled();
    expect(instance.register).toHaveBeenCalledTimes(2);
    expect(getRegistrationPlugins(instance)[0]).toBe(websocketPluginMock);
    expect(instance.register).toHaveBeenNthCalledWith(2, router, {
      prefix: '/api',
    });
    expect(server.isRunning).toBe(false);

    await server.start();
    expect(instance.listen).toHaveBeenCalledTimes(1);
    expect(server.isRunning).toBe(true);
  });

  it('throws when including routers after start', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '5.6.7.8',
      port: 7100,
    });
    await server.start();

    instance.register.mockClear();
    websocketPluginMock.mockClear();

    const router: FastifyPluginAsync = jest.fn(async () => {});

    await expect(server.includeRouter(router)).rejects.toThrow(
      'Cannot include router after HTTP server has started'
    );
    expect(websocketPluginMock).not.toHaveBeenCalled();
    expect(instance.register).not.toHaveBeenCalled();
  });

  it('supports including Fastify plugins before start', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '9.9.9.9',
      port: 7200,
    });

    const pluginWithOptions: FastifyPluginAsync = jest.fn(async () => {});
    const pluginWithoutOptions: FastifyPluginAsync = jest.fn(async () => {});

    await server.includeFastifyPlugin(pluginWithOptions, { feature: true });

    expect(instance.register).toHaveBeenNthCalledWith(2, pluginWithOptions, {
      feature: true,
    });
    expect(instance.listen).not.toHaveBeenCalled();

    instance.register.mockClear();

    await server.includeFastifyPlugin(pluginWithoutOptions);

    expect(instance.register).toHaveBeenCalledTimes(1);
    expect(instance.register).toHaveBeenCalledWith(pluginWithoutOptions);

    await server.start();
    expect(instance.listen).toHaveBeenCalledTimes(1);
  });

  it('throws when including Fastify plugins after start', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate({
      host: '12.0.0.1',
      port: 7250,
    });
    await server.start();

    instance.register.mockClear();
    websocketPluginMock.mockClear();

    const plugin: FastifyPluginAsync = jest.fn(async () => {});

    await expect(server.includeFastifyPlugin(plugin)).rejects.toThrow(
      'Cannot include plugin after HTTP server has started'
    );
    expect(instance.register).not.toHaveBeenCalled();
  });

  it('returns the same server instance for identical host and port', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const [first, second] = await Promise.all([
      DefaultHttpServer.getOrCreate({ host: '10.0.0.1', port: 7300 }),
      DefaultHttpServer.getOrCreate({ host: '10.0.0.1', port: 7300 }),
    ]);

    expect(first).toBe(second);
    expect(fastifyMock).toHaveBeenCalledTimes(1);
  });

  it('decrements references and stops when the last reference is released', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    await DefaultHttpServer.getOrCreate({ host: '11.0.0.1', port: 7400 });
    const server = await DefaultHttpServer.getOrCreate({
      host: '11.0.0.1',
      port: 7400,
    });
    await server.start();

    await DefaultHttpServer.release({ host: '11.0.0.1', port: 7400 });
    expect(instance.close).not.toHaveBeenCalled();

    await DefaultHttpServer.release({ host: '11.0.0.1', port: 7400 });
    expect(instance.close).toHaveBeenCalledTimes(1);
    expect(server.isRunning).toBe(false);
  });

  it('ignores release requests for unknown servers', async () => {
    await expect(
      DefaultHttpServer.release({ host: '127.99.0.1', port: 7500 })
    ).resolves.toBeUndefined();
  });

  it('handles missing server entries when releasing references', async () => {
    const internal = DefaultHttpServer as unknown as {
      registry: Map<string, DefaultHttpServer>;
      referenceCounts: Map<string, number>;
    };

    const key = 'ghost:0';
    internal.referenceCounts.set(key, 1);

    await DefaultHttpServer.release({ host: 'ghost', port: 0 });

    expect(internal.referenceCounts.has(key)).toBe(false);
    expect(internal.registry.has(key)).toBe(false);
  });

  it('uses default host and port when params are omitted', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const server = await DefaultHttpServer.getOrCreate();

    expect(server.host).toBe('0.0.0.0');
    expect(server.port).toBe(0);

    await DefaultHttpServer.release();

    const internal = DefaultHttpServer as unknown as {
      referenceCounts: Map<string, number>;
    };
    expect(internal.referenceCounts.has('0.0.0.0:0')).toBe(false);
  });

  it('recreates reference counts when entries are missing', async () => {
    const instance = createFastifyInstance();
    fastifyMock.prepare(instance);

    const first = await DefaultHttpServer.getOrCreate({
      host: 'ref.test',
      port: 8300,
    });

    const internal = DefaultHttpServer as unknown as {
      referenceCounts: Map<string, number>;
    };
    internal.referenceCounts.delete('ref.test:8300');

    const second = await DefaultHttpServer.getOrCreate({
      host: 'ref.test',
      port: 8300,
    });

    expect(second).toBe(first);
    expect(internal.referenceCounts.get('ref.test:8300')).toBe(1);
  });

  it('shuts down all active servers', async () => {
    const firstInstance = createFastifyInstance();
    const secondInstance = createFastifyInstance();
    fastifyMock.prepare(firstInstance);
    fastifyMock.prepare(secondInstance);

    const first = await DefaultHttpServer.getOrCreate({
      host: '12.0.0.1',
      port: 7600,
    });
    const second = await DefaultHttpServer.getOrCreate({
      host: '13.0.0.1',
      port: 7700,
    });

    await first.start();
    await second.start();

    expect(firstInstance.close).not.toHaveBeenCalled();
    expect(secondInstance.close).not.toHaveBeenCalled();

    await DefaultHttpServer.shutdownAll();

    expect(firstInstance.close).toHaveBeenCalledTimes(1);
    expect(secondInstance.close).toHaveBeenCalledTimes(1);
  });
});
