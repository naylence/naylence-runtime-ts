import {
  FameAddress,
  SINK_CAPABILITY,
  createFameEnvelope,
  type DataFrame,
  type NodeHelloFrame,
} from '@naylence/core';

import { InProcessFameFabric } from '../in-process-fame-fabric.js';
import type { NodeLike } from '../../node/node-like.js';
import type { ServiceManager } from '../../service/service-manager.js';
import type { SinkService } from '../../service/sink-service.js';
import type { FameEnvelopeHandler } from '@naylence/core';

jest.mock('../../node/node-like-factory.js', () => ({
  NodeLikeFactory: {
    createNode: jest.fn(),
  },
}));

const { NodeLikeFactory } = jest.requireMock(
  '../../node/node-like-factory.js'
) as {
  NodeLikeFactory: {
    createNode: jest.Mock;
  };
};

describe('InProcessFameFabric', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function createMockSinkService(): SinkService {
    const sinkService = {
      capabilities: [SINK_CAPABILITY],
      createSink: jest.fn(
        async ({ name }: { name: string }) => new FameAddress(`${name}@/sinks`)
      ),
      subscribe: jest.fn(async () => undefined),
      handleRpcRequest: jest.fn(async () => undefined),
    } as unknown as SinkService;

    return sinkService;
  }

  function createServiceManager(sinkService: SinkService): ServiceManager {
    return {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      registerService: jest.fn(async () => new FameAddress('service@/local')),
      getLocalServices: jest.fn(() => new Map()),
      resolveByCapability: jest.fn(() => sinkService),
      resolveAddressByCapability: jest.fn(async () => null),
    } as ServiceManager;
  }

  function createMockNode(
    serviceManager: ServiceManager,
    overrides: Partial<NodeLike> = {}
  ): NodeLike {
    const subscriberAddress = new FameAddress('subscriber@/listeners');
    const emptyAsyncIterator = async function* () {
      // no-op async iterator used for method stubs
    };

    const base = {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      send: jest.fn(async () => null),
      invoke: jest.fn(async () => undefined),
      invokeByCapability: jest.fn(async () => undefined),
      invokeStream: jest.fn(() => emptyAsyncIterator()),
      invokeByCapabilityStream: jest.fn(() => emptyAsyncIterator()),
      listen: jest.fn(
        async (_name: string, _handler: FameEnvelopeHandler) =>
          subscriberAddress
      ),
      serviceManager,
    };

    return { ...base, ...overrides } as unknown as NodeLike;
  }

  it('creates and manages node lifecycle when fabric owns the node', async () => {
    const sinkService = createMockSinkService();
    const serviceManager = createServiceManager(sinkService);
    const createdNode = createMockNode(serviceManager);

    NodeLikeFactory.createNode.mockResolvedValue(createdNode);

    const fabric = new InProcessFameFabric(undefined, {
      node: { type: 'TestNode' },
    });

    await fabric.start();

    expect(NodeLikeFactory.createNode).toHaveBeenCalledWith({
      type: 'TestNode',
    });
    expect(createdNode.start).toHaveBeenCalledTimes(1);
    expect(fabric.node).toBe(createdNode);

    await fabric.stop();
    expect(createdNode.stop).toHaveBeenCalledTimes(1);
  });

  it('subscribes to sinks and decodes data payloads before invoking handler', async () => {
    const sinkService = createMockSinkService();
    const serviceManager = createServiceManager(sinkService);

    let capturedHandler: FameEnvelopeHandler | null = null;
    const subscriberAddress = new FameAddress('subscriber@/sink');

    const mockNode = createMockNode(serviceManager, {
      listen: jest.fn(async (_name: string, handler: FameEnvelopeHandler) => {
        capturedHandler = handler;
        return subscriberAddress;
      }),
    });

    const fabric = new InProcessFameFabric(mockNode);
    await fabric.start();

    const sinkAddress = new FameAddress('sink@/data');
    const messageHandler = jest.fn(async () => undefined);

    await fabric.subscribe(sinkAddress, messageHandler, ' custom-name ');

    expect(mockNode.listen).toHaveBeenCalledWith(
      'custom-name',
      expect.any(Function)
    );
    expect(sinkService.subscribe).toHaveBeenCalledWith({
      sinkAddress: sinkAddress.toString(),
      subscriberAddress: subscriberAddress.toString(),
    });

    expect(capturedHandler).toBeInstanceOf(Function);

    const dataFrame: DataFrame = {
      type: 'Data',
      payload: { hello: 'world' },
    };
    const envelope = createFameEnvelope({ frame: dataFrame });

    const response = await capturedHandler!(envelope);

    expect(messageHandler).toHaveBeenCalledWith({ hello: 'world' });
    expect(response).toBeNull();
  });

  it('throws when sink subscription receives a non-data frame', async () => {
    const sinkService = createMockSinkService();
    const serviceManager = createServiceManager(sinkService);

    let capturedHandler: FameEnvelopeHandler | null = null;
    const mockNode = createMockNode(serviceManager, {
      listen: jest.fn(async (_name: string, handler: FameEnvelopeHandler) => {
        capturedHandler = handler;
        return new FameAddress('subscriber@/invalid');
      }),
    });

    const fabric = new InProcessFameFabric(mockNode);
    await fabric.start();

    const sinkAddress = new FameAddress('sink@/data');
    const handler = jest.fn(async () => undefined);

    await fabric.subscribe(sinkAddress, handler, 'listener');

    const nodeHelloFrame: NodeHelloFrame = {
      type: 'NodeHello',
      systemId: 'sys',
      instanceId: 'instance',
    };
    const envelope = createFameEnvelope({ frame: nodeHelloFrame });

    await expect(capturedHandler!(envelope)).rejects.toThrow(
      'Invalid envelope frame type'
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
