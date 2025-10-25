import type { CreateSinkParams, SubscribeParams } from '../sink-service.js';
import {
  InMemorySinkService,
  InMemorySinkServiceFactory,
  type SinkBindingManager,
} from '../in-memory-sink-service.js';

jest.mock('@naylence/core', () => {
  const extractEnvelopeAndContext = jest.fn((message: any) => {
    if (!message) {
      return [null, undefined];
    }

    if (Array.isArray(message)) {
      return message as [unknown, unknown];
    }

    if (typeof message === 'object' && message !== null) {
      const envelope =
        'envelope' in message
          ? ((message as any).envelope ?? null)
          : ((message as any) ?? null);
      const context =
        'context' in message ? (message as any).context : undefined;
      return [envelope, context];
    }

    return [null, undefined];
  });

  const makeFameAddress = jest.fn((value: unknown) => ({
    raw: value,
    toString(): string {
      return String(value);
    },
  }));

  const FameFabric = {
    current: jest.fn(() => ({
      send: jest.fn(async () => undefined),
    })),
  };

  class Subscription {
    public readonly channel: any;
    public readonly address: { toString(): string };

    constructor(channel: any, address: { toString(): string }) {
      this.channel = channel;
      this.address = address;
    }
  }

  class Binding {
    public readonly address: { toString(): string };
    public readonly channel: any;

    constructor(address: { toString(): string }, channel: any) {
      this.address = address;
      this.channel = channel;
    }
  }

  return {
    extractEnvelopeAndContext,
    generateId: jest.fn(() => 'mock-id'),
    makeFameAddress,
    FameFabric,
    Subscription,
    Binding,
  };
});

jest.mock('../../channel/in-memory/in-memory-fanout-broker.js', () => {
  const instances: Array<{
    addSubscriber: jest.Mock;
    removeSubscriber: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    channel: unknown;
  }> = [];

  class InMemoryFanoutBroker {
    public readonly addSubscriber = jest.fn();
    public readonly removeSubscriber = jest.fn();
    public readonly start = jest.fn(async () => undefined);
    public readonly stop = jest.fn(async () => undefined);

    constructor(
      public readonly channel: unknown,
      public readonly config: unknown
    ) {
      instances.push(this);
    }
  }

  return {
    InMemoryFanoutBroker,
    __getInstances: () => instances,
    __reset: () => {
      instances.splice(0, instances.length);
    },
  };
});

jest.mock('../../util/logging.js', () => {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  };

  return {
    getLogger: jest.fn(() => logger),
    __mockLogger: logger,
  };
});

describe('InMemorySinkService', () => {
  const core = require('@naylence/core');
  const fanoutModule = require('../../channel/in-memory/in-memory-fanout-broker.js');
  const loggingModule = require('../../util/logging.js');
  const mockLogger: Record<string, jest.Mock> = loggingModule.__mockLogger;

  const createBindingManager = (binding: unknown): SinkBindingManager => ({
    bind: jest.fn(async () => binding as any),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fanoutModule.__reset();
    let counter = 0;
    core.generateId.mockImplementation(() => `generated-${++counter}`);
    core.extractEnvelopeAndContext.mockImplementation((message: any) => {
      if (!message) {
        return [null, undefined];
      }
      if (typeof message === 'object' && message !== null) {
        const envelope =
          'envelope' in message
            ? ((message as any).envelope ?? null)
            : ((message as any) ?? null);
        const context =
          'context' in message ? (message as any).context : undefined;
        return [envelope, context];
      }
      return [null, undefined];
    });
    (core.FameFabric.current as jest.Mock).mockImplementation(() => ({
      send: jest.fn(async () => undefined),
    }));
  });

  const createBinding = (address: string) => ({
    address: {
      toString(): string {
        return address;
      },
    },
    channel: {},
  });

  it('creates sinks using binding manager and starts broker', async () => {
    const binding = createBinding('sink-one');
    const bindingManager = createBindingManager(binding);
    const service = new InMemorySinkService({ bindingManager });

    const result = await service.createSink({
      name: ' sink-one ',
    } as CreateSinkParams);

    expect(bindingManager.bind).toHaveBeenCalledWith('sink-one');
    expect(result).toBe(binding.address);

    const instances = fanoutModule.__getInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect((service as any).fanouts.get('sink-one')).toBe(instances[0]);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'created_sink',
      expect.any(Object)
    );
  });

  it('generates sink name when none provided', async () => {
    const binding = createBinding('sink-generated');
    const bindingManager = createBindingManager(binding);
    const service = new InMemorySinkService({ bindingManager });

    await service.createSink({} as CreateSinkParams);

    expect(bindingManager.bind).toHaveBeenCalledWith('sink-generated-1');
  });

  it('throws when binding manager does not return binding', async () => {
    const bindingManager: SinkBindingManager = {
      bind: jest.fn(async () => null as any),
    };
    const service = new InMemorySinkService({ bindingManager });

    await expect(
      service.createSink({ name: 'x' } as CreateSinkParams)
    ).rejects.toThrow('Binding manager did not return a binding');
  });

  it('requires sink and subscriber addresses when subscribing', async () => {
    const service = new InMemorySinkService({
      bindingManager: createBindingManager(createBinding('sink')),
    });

    await expect(
      service.subscribe({ subscriberAddress: 'dest' } as SubscribeParams)
    ).rejects.toThrow('sinkAddress and subscriberAddress are required');

    await expect(
      service.subscribe({ sinkAddress: 'sink' } as SubscribeParams)
    ).rejects.toThrow('sinkAddress and subscriberAddress are required');
  });

  it('throws when subscribing to unknown sink', async () => {
    const service = new InMemorySinkService({
      bindingManager: createBindingManager(createBinding('sink')),
    });

    await expect(
      service.subscribe({ sinkAddress: 'unknown', subscriberAddress: 'dest' })
    ).rejects.toThrow('No sink found for unknown');
  });

  it('subscribes consumers, delivers messages, and handles missing envelopes', async () => {
    const binding = createBinding('sink-subs');
    const bindingManager = createBindingManager(binding);
    const deliver = jest.fn(async () => undefined);
    const service = new InMemorySinkService({ bindingManager, deliver });

    await service.createSink({ name: 'sink-subs' } as CreateSinkParams);

    await service.subscribe({
      sinkAddress: 'sink-subs',
      subscriberAddress: 'subscriber',
    });

    const instances = fanoutModule.__getInstances();
    const channel = instances[0].addSubscriber.mock.calls[0][0] as {
      send: (message: any) => Promise<void>;
    };

    const message = {
      envelope: {
        id: 'env-1',
        to: 'original',
      },
      context: { traceId: 'trace' },
    };

    await channel.send(message);

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'env-1',
        to: 'subscriber',
      }),
      message.context
    );

    const previousCalls = deliver.mock.calls.length;
    const coreModule = require('@naylence/core');
    coreModule.extractEnvelopeAndContext.mockImplementationOnce(() => [
      null,
      undefined,
    ]);

    await channel.send({});

    expect(deliver).toHaveBeenCalledTimes(previousCalls);
  });

  it('propagates delivery errors from channel and logs failure', async () => {
    const binding = createBinding('sink-error');
    const bindingManager = createBindingManager(binding);
    const deliver = jest.fn(async () => {
      throw new Error('boom');
    });
    const service = new InMemorySinkService({ bindingManager, deliver });

    await service.createSink({ name: 'sink-error' } as CreateSinkParams);
    await service.subscribe({
      sinkAddress: 'sink-error',
      subscriberAddress: 'subscriber',
    });

    const instances = fanoutModule.__getInstances();
    const channel = instances[0].addSubscriber.mock.calls[0][0] as {
      send: (message: any) => Promise<void>;
    };

    await expect(
      channel.send({ envelope: { id: 'env', to: 'value' }, context: {} })
    ).rejects.toThrow('boom');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'sink_delivery_failed',
      expect.objectContaining({ error: 'boom' })
    );
  });

  it('default deliver sends via FameFabric and validates destination', async () => {
    const binding = createBinding('sink-default');
    const bindingManager = createBindingManager(binding);
    const service = new InMemorySinkService({ bindingManager });
    const coreModule = require('@naylence/core');

    const deliverFn = (service as any).deliver as (
      env: any,
      ctx?: any
    ) => Promise<void>;

    await expect(deliverFn({ id: 'env-no-dest' }, undefined)).rejects.toThrow(
      'Sink delivery envelope requires a destination address'
    );

    const sendSpy = jest.fn(async () => undefined);
    (coreModule.FameFabric.current as jest.Mock).mockReturnValueOnce({
      send: sendSpy,
    });

    await deliverFn(
      { id: 'env-dest', to: { toString: () => 'dest-string' } },
      { scope: 'ctx' }
    );

    expect(coreModule.FameFabric.current).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith({ id: 'env-dest', to: 'dest-string' });
  });

  it('records subscriptions and removes them on unsubscribe', async () => {
    const binding = createBinding('sink-unsub');
    const bindingManager = createBindingManager(binding);
    const service = new InMemorySinkService({ bindingManager });

    await service.createSink({ name: 'sink-unsub' } as CreateSinkParams);
    await service.subscribe({
      sinkAddress: 'sink-unsub',
      subscriberAddress: 'subscriber',
    });

    const subscriptions: Array<any> = (service as any).subscriptions.get(
      'sink-unsub'
    );
    expect(subscriptions).toHaveLength(1);

    const stored = subscriptions[0];
    const fanout = fanoutModule.__getInstances()[0];
    fanout.removeSubscriber.mockClear();
    const closeSpy = jest.spyOn(stored.channel, 'close');

    await service.unsubscribe(stored);

    expect(fanout.removeSubscriber).toHaveBeenCalledWith(stored.channel);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((service as any).subscriptions.has('sink-unsub')).toBe(false);
    expect((service as any).subscriptionIndex.has(stored)).toBe(false);
  });

  it('ignores unsubscribe for unknown subscriptions', async () => {
    const bindingManager = createBindingManager(createBinding('sink'));
    const service = new InMemorySinkService({ bindingManager });
    const coreModule = require('@naylence/core');
    const orphan = new coreModule.Subscription(
      { close: jest.fn() },
      { toString: () => 'addr' }
    );

    await expect(service.unsubscribe(orphan)).resolves.toBeUndefined();
  });

  it('stops brokers and logs failures during shutdown', async () => {
    const bindingManager = createBindingManager(createBinding('sink'));
    const service = new InMemorySinkService({ bindingManager });

    const brokerOne = new fanoutModule.InMemoryFanoutBroker({}, {});
    const brokerTwo = new fanoutModule.InMemoryFanoutBroker({}, {});
    brokerTwo.stop.mockImplementation(async () => {
      throw new Error('stop failure');
    });

    (service as any).fanouts.set('one', brokerOne);
    (service as any).fanouts.set('two', brokerTwo);
    (service as any).subscriptions.set('one', []);

    await service.stop();

    expect(brokerOne.stop).toHaveBeenCalledTimes(1);
    expect(brokerTwo.stop).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'failed_to_stop_fanout_broker',
      expect.any(Object)
    );
    expect((service as any).fanouts.size).toBe(0);
    expect((service as any).subscriptions.size).toBe(0);
  });

  it('routes RPC requests to handlers and rejects unknown methods', async () => {
    const binding = createBinding('sink-rpc');
    const bindingManager = createBindingManager(binding);
    const service = new InMemorySinkService({ bindingManager });

    const createSpy = jest
      .spyOn(service, 'createSink')
      .mockResolvedValue(binding.address as any);
    const subscribeSpy = jest.spyOn(service, 'subscribe').mockResolvedValue();

    await service.handleRpcRequest('createSink', { name: 'sink' });
    await service.handleRpcRequest('subscribe', {
      sinkAddress: 'sink',
      subscriberAddress: 'sub',
    });
    await service.handleRpcRequest('sink/create', { name: 'sink' });
    await service.handleRpcRequest('create_sink', { name: 'sink' });

    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    await expect(service.handleRpcRequest('unknown', {})).rejects.toThrow(
      'Unknown RPC method: unknown'
    );
  });

  it('handles unsubscribe when updated list retains other subscriptions', async () => {
    const binding = createBinding('sink-multi');
    const bindingManager = createBindingManager(binding);
    const service = new InMemorySinkService({ bindingManager });

    await service.createSink({ name: 'sink-multi' } as CreateSinkParams);
    await service.subscribe({
      sinkAddress: 'sink-multi',
      subscriberAddress: 'one',
    });
    await service.subscribe({
      sinkAddress: 'sink-multi',
      subscriberAddress: 'two',
    });

    const subscriptions: Array<any> = (service as any).subscriptions.get(
      'sink-multi'
    );
    const toRemove = subscriptions[0];
    const fanout = fanoutModule.__getInstances()[0];
    fanout.removeSubscriber.mockClear();

    await service.unsubscribe(toRemove);

    expect(fanout.removeSubscriber).toHaveBeenCalledWith(toRemove.channel);
    expect((service as any).subscriptions.get('sink-multi')).toHaveLength(1);
  });
});

describe('InMemorySinkServiceFactory', () => {
  it('requires binding manager', () => {
    const factory = new InMemorySinkServiceFactory();
    expect(() => factory.create({} as any)).toThrow(
      'bindingManager is required to create InMemorySinkService'
    );
  });

  it('passes through optional configuration', () => {
    const binding = {
      address: {
        toString(): string {
          return 'sink';
        },
      },
      channel: {},
    };

    const bindingManager: SinkBindingManager = {
      bind: jest.fn(async () => binding as any),
    };

    const deliver = jest.fn(async () => undefined);
    const factory = new InMemorySinkServiceFactory();
    const service = factory.create({ bindingManager, deliver, name: 'custom' });

    expect(service).toBeInstanceOf(InMemorySinkService);
    expect(service.name).toBe('custom');
  });

  it('creates service with defaults when optional config omitted', () => {
    const binding = {
      address: {
        toString(): string {
          return 'sink';
        },
      },
      channel: {},
    };

    const bindingManager: SinkBindingManager = {
      bind: jest.fn(async () => binding as any),
    };

    const factory = new InMemorySinkServiceFactory();
    const service = factory.create({ bindingManager });

    expect(service).toBeInstanceOf(InMemorySinkService);
    expect(service.name).toBe('sink-service');
  });
});
