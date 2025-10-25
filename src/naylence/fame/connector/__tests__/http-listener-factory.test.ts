import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const HttpListenerMock = jest.fn();

jest.unstable_mockModule('../http-listener.js', () => ({
  HttpListener: HttpListenerMock,
}));

describe('HttpListenerFactory', () => {
  let factoryModule: typeof import('../http-listener-factory.js');
  let factoryInstance: import('../http-listener-factory.js').HttpListenerFactory;
  let capturedConfig: { host: string; port: number } | null;
  let createDefaultSpy: jest.SpiedFunction<
    (typeof import('../http-listener-factory.js'))['HttpListenerFactory']['prototype']['_createDefaultHttpServer']
  >;
  let serverMock: import('../http-server.js').HttpServer &
    import('../../node/node-event-listener.js').NodeEventListener;

  beforeAll(async () => {
    factoryModule = await import('../http-listener-factory.js');
  });

  beforeEach(() => {
    HttpListenerMock.mockClear();
    capturedConfig = null;

    let running = false;
    serverMock = {
      host: '0.0.0.0',
      port: 0,
      actualHost: null,
      actualPort: null,
      actualBaseUrl: null,
      get isRunning() {
        return running;
      },
      priority: 1000,
      async start() {
        running = true;
      },
      async stop() {
        running = false;
      },
      async includeRouter(_router?: unknown, _options?: { prefix?: string }) {
        return;
      },
    };

    createDefaultSpy = jest
      .spyOn(
        factoryModule.HttpListenerFactory.prototype as any,
        '_createDefaultHttpServer'
      )
      .mockImplementation(async (...args: unknown[]) => {
        const [normalized] = args as [{ host: string; port: number }];
        capturedConfig = normalized;
        return serverMock as unknown as import('../http-server.js').HttpServer;
      });

    factoryInstance = new factoryModule.HttpListenerFactory();
  });

  afterEach(() => {
    createDefaultSpy.mockRestore();
  });

  it('parses numeric strings for port configuration', async () => {
    await factoryInstance.create(
      {
        type: 'HttpListener',
        port: '8001',
      } as unknown as { type: 'HttpListener'; port: number | string },
      []
    );

    expect(capturedConfig).toMatchObject({ host: '0.0.0.0', port: 8001 });
  });

  it('adds the default HTTP server to event listeners', async () => {
    const listeners: Array<
      import('../../node/node-event-listener.js').NodeEventListener
    > = [];

    await factoryInstance.create(
      { type: 'HttpListener' } as unknown as {
        type: 'HttpListener';
      },
      listeners
    );

    expect(listeners).toContain(serverMock);
  });
});
