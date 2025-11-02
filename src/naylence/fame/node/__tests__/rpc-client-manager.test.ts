import {
  DeliveryOriginType,
  FameResponseType,
  type FameAddress,
} from '@naylence/core';
import { RPCClientManager } from '../rpc-client-manager.js';

var loggerInstance: {
  debug: jest.Mock;
  warning: jest.Mock;
};
var coreMocks: {
  generateId: jest.Mock;
  makeRequest: jest.Mock;
  parseResponse: jest.Mock;
  formatAddress: jest.Mock;
};

const getCoreMocks = () => {
  if (!coreMocks) {
    throw new Error('coreMocks not initialised');
  }
  return coreMocks;
};

const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

jest.mock('../../util/logging.js', () => {
  loggerInstance = {
    debug: jest.fn(),
    warning: jest.fn(),
  };
  return {
    getLogger: jest.fn(() => loggerInstance),
  };
});

jest.mock('../../util/envelope-context.js', () => ({
  currentTraceId: jest.fn(),
}));

const { currentTraceId: currentTraceIdMock } = jest.requireMock(
  '../../util/envelope-context.js'
) as { currentTraceId: jest.Mock };

const getCurrentTraceMock = () => currentTraceIdMock;

const getLoggerMock = () =>
  (jest.requireMock('../../util/logging.js') as { getLogger: jest.Mock })
    .getLogger;

jest.mock('@naylence/core', () => {
  const actual = jest.requireActual('@naylence/core');
  coreMocks = {
    generateId: jest.fn(),
    makeRequest: jest.fn(),
    parseResponse: jest.fn(),
    formatAddress: jest.fn((recipient: string, path: string) => ({
      toString: () => `${recipient}@${path}`,
    })),
  };
  return {
    ...actual,
    generateId: coreMocks.generateId,
    makeRequest: coreMocks.makeRequest,
    parseResponse: coreMocks.parseResponse,
    formatAddress: coreMocks.formatAddress,
  };
});

describe('RPCClientManager', () => {
  const defaultEnvelopeFactory = {
    createEnvelope: jest.fn((options) => ({
      id: `${options.corrId}-envelope`,
      corrId: options.corrId,
      frame: options.frame,
      to: options.to,
      responseType: options.responseType,
      replyTo: options.replyTo,
    })),
  };

  const defaultDeliveryTracker = {
    track: jest.fn().mockResolvedValue(undefined),
    onStreamItem: jest.fn().mockResolvedValue(undefined),
    onStreamEnd: jest.fn().mockResolvedValue(undefined),
    addEventHandler: jest.fn(),
    removeEventHandler: jest.fn(),
  };

  const defaultDeliverFn = jest.fn().mockResolvedValue(undefined);
  const defaultDeliverWrapper = jest.fn(() => defaultDeliverFn);
  const defaultListenCallback = jest
    .fn()
    .mockResolvedValue({ toString: () => 'listener@/node' });

  const managers: RPCClientManager[] = [];

  const createManager = () => {
    const manager = new RPCClientManager(
      () => '/node',
      () => 'node-1',
      defaultDeliverWrapper,
      defaultEnvelopeFactory as never,
      defaultListenCallback as never,
      defaultDeliveryTracker as never
    );
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    const mocks = getCoreMocks();
    mocks.formatAddress.mockClear();
    mocks.formatAddress.mockImplementation(
      (recipient: string, path: string) => ({
        toString: () => `${recipient}@${path}`,
      })
    );
    mocks.generateId.mockReset();
    mocks.makeRequest.mockReset();
    mocks.parseResponse.mockReset();
    getCurrentTraceMock().mockReset();
    const loggerMock = getLoggerMock();
    loggerMock.mockReset();
    loggerMock.mockReturnValue(loggerInstance);
    loggerInstance.debug.mockReset();
    loggerInstance.warning.mockReset();
    defaultEnvelopeFactory.createEnvelope.mockClear();
    defaultDeliveryTracker.track.mockClear();
    defaultDeliveryTracker.track.mockResolvedValue(undefined);
    defaultDeliveryTracker.onStreamItem.mockClear();
    defaultDeliveryTracker.onStreamItem.mockResolvedValue(undefined);
    defaultDeliveryTracker.onStreamEnd.mockClear();
    defaultDeliveryTracker.onStreamEnd.mockResolvedValue(undefined);
    defaultDeliveryTracker.addEventHandler.mockClear();
    defaultDeliveryTracker.removeEventHandler.mockClear();
    defaultDeliverFn.mockClear();
    defaultDeliverFn.mockResolvedValue(undefined);
    defaultDeliverWrapper.mockClear();
    defaultDeliverWrapper.mockImplementation(() => defaultDeliverFn);
    defaultListenCallback.mockClear();
    defaultListenCallback.mockResolvedValue({
      toString: () => 'listener@/node',
    });
  });

  afterEach(async () => {
    await Promise.all(managers.map((m) => m.cleanup()));
    managers.length = 0;
  });

  it('rejects when neither target nor capabilities are provided', async () => {
    const manager = createManager();
    await expect(
      manager.invoke({ method: 'noop', params: {} })
    ).rejects.toThrow('Either target address or capabilities must be provided');
  });

  it('rejects when both target and capabilities are provided', async () => {
    const manager = createManager();
    await expect(
      manager.invoke({
        targetAddr: { toString: () => 'target' } as never,
        capabilities: ['cap'],
        method: 'noop',
        params: {},
      })
    ).rejects.toThrow(
      'Provide either target address or capabilities, not both'
    );
  });

  it('omits replyTo when reply address is unavailable and includes trace id for stream', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();
    const traceMock = getCurrentTraceMock();

    mocks.generateId.mockReturnValueOnce('listener-recipient-1');
    mocks.formatAddress.mockReturnValueOnce(null as never);
    traceMock.mockReturnValueOnce('trace-single');
    mocks.generateId.mockReturnValueOnce('no-reply-single');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'single' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'ok' });

    const singlePromise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    const singleEnvelope =
      defaultEnvelopeFactory.createEnvelope.mock.calls[0][0];
    expect(singleEnvelope.replyTo).toBeUndefined();
    expect(singleEnvelope.traceId).toBe('trace-single');

    await (manager as any).handleReplyEnvelope({
      id: 'reply-single',
      corrId: 'no-reply-single',
      frame: { type: 'Data', payload: { result: 'ok' } },
    });

    await expect(singlePromise).resolves.toBe('ok');

    traceMock.mockReturnValueOnce('trace-stream');
    mocks.generateId.mockReturnValueOnce('no-reply-stream');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'stream' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'value' });
    mocks.parseResponse.mockReturnValueOnce({ result: null });

    const iterator = (await manager.invokeStream({
      capabilities: [],
      method: 'stream',
      params: {},
    })) as AsyncIterableIterator<unknown>;

    await flushAsync();

    const streamEnvelope =
      defaultEnvelopeFactory.createEnvelope.mock.calls[1][0];
    expect(streamEnvelope.capabilities).toBeUndefined();
    expect(streamEnvelope.replyTo).toBeUndefined();
    expect(streamEnvelope.traceId).toBe('trace-stream');

    await (manager as any).handleReplyEnvelope({
      id: 'reply-stream-value',
      corrId: 'no-reply-stream',
      frame: { type: 'Data', payload: { result: 'value' } },
    });

    await (manager as any).handleReplyEnvelope({
      id: 'reply-stream-end',
      corrId: 'no-reply-stream',
      frame: { type: 'Data', payload: { result: null } },
    });

    await expect(iterator.next()).resolves.toEqual({
      value: 'value',
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });

    expect(defaultDeliveryTracker.onStreamItem).toHaveBeenCalledTimes(2);
    expect(defaultDeliveryTracker.onStreamItem).toHaveBeenLastCalledWith(
      expect.stringMatching(/no-reply-stream-envelope/),
      expect.objectContaining({ id: 'reply-stream-end' })
    );
    expect(defaultDeliveryTracker.onStreamEnd).toHaveBeenCalledTimes(1);
    expect(defaultDeliveryTracker.onStreamEnd).toHaveBeenCalledWith(
      expect.stringMatching(/no-reply-stream-envelope/)
    );
  });

  it('rejects when invoking stream without target or capabilities', async () => {
    const manager = createManager();

    await expect(
      manager.invokeStream({ method: 'stream', params: {} })
    ).rejects.toThrow('Either target address or capabilities must be provided');
  });

  it('rejects when stream invocation provides target and capabilities', async () => {
    const manager = createManager();

    await expect(
      manager.invokeStream({
        targetAddr: { toString: () => 'target' } as never,
        capabilities: ['cap'],
        method: 'stream',
        params: {},
      })
    ).rejects.toThrow(
      'Provide either target address or capabilities, not both'
    );
  });

  it('binds listener once and resolves replies for single requests', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();
    const traceMock = getCurrentTraceMock();
    mocks.generateId.mockReturnValueOnce('listener-recipient');
    traceMock.mockReturnValueOnce('trace-1');
    mocks.generateId.mockReturnValueOnce('req-1');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request-1' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'alpha' });

    const firstPromise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: { value: 1 },
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-1',
      corrId: 'req-1',
      frame: { type: 'Data', payload: { result: 'alpha' } },
    });

    await expect(firstPromise).resolves.toBe('alpha');

    const targetAddr = { toString: () => 'target@/node' };
    traceMock.mockReturnValueOnce(undefined);
    mocks.generateId.mockReturnValueOnce('req-2');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request-2' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'beta' });

    const secondPromise = manager.invoke({
      targetAddr: targetAddr as never,
      method: 'call2',
      params: { value: 2 },
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-2',
      corrId: 'req-2',
      frame: { type: 'Data', payload: { result: 'beta' } },
    });

    await expect(secondPromise).resolves.toBe('beta');

    expect(defaultListenCallback).toHaveBeenCalledTimes(1);
    expect(defaultEnvelopeFactory.createEnvelope).toHaveBeenCalledTimes(2);
    const [firstCall] = defaultEnvelopeFactory.createEnvelope.mock.calls;
    expect(firstCall[0].capabilities).toEqual(['cap']);
    expect(firstCall[0].replyTo?.toString()).toMatch(/__rpc__[\w-]+@\/node/);
    const secondCall = defaultEnvelopeFactory.createEnvelope.mock.calls[1][0];
    expect(secondCall.to).toBe(targetAddr);
    expect(secondCall.capabilities).toBeUndefined();
    expect(defaultDeliverWrapper).toHaveBeenCalledTimes(2);
    expect(defaultDeliverFn).toHaveBeenCalledTimes(2);
    expect(defaultDeliverFn.mock.calls[0][1]).toEqual({
      originType: DeliveryOriginType.LOCAL,
      fromSystemId: 'node-1',
      expectedResponseType: FameResponseType.REPLY,
    });
  });

  it('supports snake_case invoke options', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

  const targetAddr = 'alias@/remote' as unknown as FameAddress;
    mocks.generateId.mockReturnValueOnce('listener-alias');
    mocks.generateId.mockReturnValueOnce('req-alias');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'alias-request' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'alias-ok' });

    const promise = manager.invoke({
      target_addr: targetAddr,
      method: 'aliasCall',
      params: { value: 42 },
      timeout_ms: '1500',
    });

    await flushAsync();

    const envelopeArgs =
      defaultEnvelopeFactory.createEnvelope.mock.calls[0][0];
    expect(envelopeArgs.to).toBe(targetAddr);
    expect(envelopeArgs.capabilities).toBeUndefined();
    expect(envelopeArgs.replyTo?.toString()).toMatch(/__rpc__.*@\/node/);

    const trackArgs = defaultDeliveryTracker.track.mock.calls[0][1];
    expect(trackArgs.timeoutMs).toBe(1500);

    await (manager as any).handleReplyEnvelope({
      id: 'reply-alias',
      corrId: 'req-alias',
      frame: { type: 'Data', payload: { result: 'alias-ok' } },
    });

    await expect(promise).resolves.toBe('alias-ok');
  });

  it('supports snake_case invokeStream options', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    const targetAddr = 'stream@/remote' as unknown as FameAddress;
    mocks.generateId.mockReturnValueOnce('listener-stream-alias');
    mocks.generateId.mockReturnValueOnce('req-stream-alias');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'stream-alias' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'value-1' });
    mocks.parseResponse.mockReturnValueOnce({ result: null });

    const iterator = (await manager.invokeStream({
      target_addr: targetAddr,
      method: 'streamAlias',
      params: undefined,
      timeout_ms: 2500,
    })) as AsyncIterableIterator<unknown>;

    await flushAsync();

    const trackArgs = defaultDeliveryTracker.track.mock.calls[0][1];
    expect(trackArgs.timeoutMs).toBe(2500);
    expect(trackArgs.expectedResponseType).toBe(FameResponseType.STREAM);

    await (manager as any).handleReplyEnvelope({
      id: 'stream-reply-1',
      corrId: 'req-stream-alias',
      frame: { type: 'Data', payload: { result: 'value-1' } },
    });
    await (manager as any).handleReplyEnvelope({
      id: 'stream-reply-end',
      corrId: 'req-stream-alias',
      frame: { type: 'Data', payload: { result: null } },
    });

    await expect(iterator.next()).resolves.toEqual({
      value: 'value-1',
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });

    const envelopeArgs =
      defaultEnvelopeFactory.createEnvelope.mock.calls[0][0];
    expect(envelopeArgs.to).toBe(targetAddr);

    expect(defaultDeliveryTracker.onStreamItem).toHaveBeenCalled();
    expect(defaultDeliveryTracker.onStreamEnd).toHaveBeenCalled();
  });

  it('continues delivery when delivery tracker tracking fails', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('req-track');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'ok' });
    defaultDeliveryTracker.track.mockRejectedValueOnce(
      new Error('tracker failure')
    );

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await flushAsync();

    await flushAsync();

    await flushAsync();

    await flushAsync();

    await flushAsync();

    expect(defaultDeliverWrapper).toHaveBeenCalledTimes(1);
    expect(defaultDeliverFn).toHaveBeenCalledTimes(1);

    await (manager as any).handleReplyEnvelope({
      id: 'reply-track',
      corrId: 'req-track',
      frame: { type: 'Data', payload: { result: 'ok' } },
    });

    await expect(promise).resolves.toBe('ok');
    expect(loggerInstance.warning).toHaveBeenCalledWith(
      'delivery_tracker_track_failed',
      expect.objectContaining({ request_id: 'req-track' })
    );
  });

  it('sends requests even when delivery tracker is unavailable', async () => {
    const mocks = getCoreMocks();
    const deliverFn = jest.fn().mockResolvedValue(undefined);
    const deliverWrapper = jest.fn(() => deliverFn);
    const manager = new RPCClientManager(
      () => '/node',
      () => 'node-1',
      deliverWrapper,
      defaultEnvelopeFactory as never,
      defaultListenCallback as never,
      undefined as never
    );
    managers.push(manager);

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('no-tracker');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'body' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'ok' });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-no-tracker',
      corrId: 'no-tracker',
      frame: { type: 'Data', payload: { result: 'ok' } },
    });

    await expect(promise).resolves.toBe('ok');
    expect(deliverWrapper).toHaveBeenCalledTimes(1);
    expect(deliverFn).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate pending requests', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValue('dup-id');
    mocks.makeRequest.mockReturnValue({ payload: 'dup' });
    mocks.parseResponse.mockReturnValue({ result: 'ok' });

    const firstPromise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
      timeoutMs: 5,
    });

    await flushAsync();

    await expect(
      manager.invoke({ capabilities: ['cap'], method: 'call', params: {} })
    ).rejects.toThrow('Request dup-id is already pending');

    await manager.cleanup();
    await expect(firstPromise).rejects.toThrow('RPC client cleaned up');
  });

  it('times out pending single requests when no reply arrives', async () => {
    jest.useFakeTimers();
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('timeout-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'slow' });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'slow',
      params: {},
      timeoutMs: 10,
    });

    await flushAsync();

    jest.advanceTimersByTime(11);
    await expect(promise).rejects.toThrow(
      'Timeout waiting for RPC response timeout-id'
    );
    jest.useRealTimers();
  });

  it('delivers streaming responses and terminates on null results', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('stream-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'stream request' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'first' });
    mocks.parseResponse.mockReturnValueOnce({ result: null });

    const iterator = (await manager.invokeStream({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
    })) as AsyncIterableIterator<unknown>;

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-stream-1',
      corrId: 'stream-id',
      frame: { type: 'Data', payload: { result: 'first' } },
    });

    await (manager as any).handleReplyEnvelope({
      id: 'reply-stream-2',
      corrId: 'stream-id',
      frame: { type: 'Data', payload: { result: null } },
    });

    await expect(iterator.next()).resolves.toEqual({
      value: 'first',
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('resolves pending stream next calls and handles iterator return', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('await-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'stream request' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'delayed' });

    const iterator = (await manager.invokeStream({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
    })) as AsyncIterableIterator<unknown>;

    const pendingBeforeReply = iterator.next();

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-delayed',
      corrId: 'await-id',
      frame: { type: 'Data', payload: { result: 'delayed' } },
    });

    await expect(pendingBeforeReply).resolves.toEqual({
      value: 'delayed',
      done: false,
    });

    const entryBeforeReturn = (manager as any).pending.get('await-id');
    expect(entryBeforeReturn).toBeDefined();

    const originalPush = entryBeforeReturn.push.bind(entryBeforeReturn);
    const pushSpy = jest.fn(originalPush);
    entryBeforeReturn.push = pushSpy;

    if (!iterator.return) {
      throw new Error('Expected iterator.return to be defined');
    }

    await expect(iterator.return()).resolves.toEqual({
      value: undefined,
      done: true,
    });

    expect((manager as any).pending.has('await-id')).toBe(false);

    entryBeforeReturn.push('late-value');
    expect(pushSpy).toHaveBeenCalledWith('late-value');

    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('propagates iterator.throw errors and clears pending stream entries', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('throw-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'stream request' });
    mocks.parseResponse.mockReturnValueOnce({ result: 'first' });

    const iterator = (await manager.invokeStream({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
    })) as AsyncIterableIterator<unknown>;

    await (manager as any).handleReplyEnvelope({
      id: 'reply-stream-throw',
      corrId: 'throw-id',
      frame: { type: 'Data', payload: { result: 'first' } },
    });

    await iterator.next();
    if (!iterator.throw) {
      throw new Error('Expected iterator.throw to be defined');
    }
    await expect(iterator.throw('abort')).rejects.toThrow('abort');
    expect((manager as any).pending.has('throw-id')).toBe(false);
  });

  it('rejects single requests when reply frame is not data', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('frame-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-frame',
      corrId: 'frame-id',
      frame: { type: 'Unexpected' },
    });

    await flushAsync();

    await expect(promise).rejects.toThrow('Unexpected frame type in reply');
    expect(loggerInstance.warning).toHaveBeenCalledWith(
      'unexpected_reply_frame_type',
      expect.objectContaining({ request_id: 'frame-id' })
    );
  });

  it('rejects responses carrying rpc errors', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('error-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });
    mocks.parseResponse.mockReturnValueOnce({
      error: { message: 'rpc error' },
    });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-error',
      corrId: 'error-id',
      frame: { type: 'Data', payload: { result: null } },
    });

    await flushAsync();

    await expect(promise).rejects.toThrow('rpc error');
  });

  it('rejects when parseResponse throws', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('parse-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });
    mocks.parseResponse.mockImplementationOnce(() => {
      throw new Error('parse failure');
    });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-parse',
      corrId: 'parse-id',
      frame: { type: 'Data', payload: { result: 'unused' } },
    });

    await flushAsync();

    await expect(promise).rejects.toThrow('parse failure');
  });

  it('rejects requests when delivery ack indicates signature required', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('ack-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-ack',
      corrId: 'ack-id',
      frame: {
        type: 'DeliveryAck',
        code: 'signature_required',
        reason: 'missing',
      },
    });

    await flushAsync();

    await expect(promise).rejects.toThrow(
      'Message rejected because it lacks a required digital signature.'
    );
  });

  it.each([
    [
      'crypto_level_violation',
      'Message rejected due to insufficient encryption.',
    ],
    [
      'signature_verification_failed',
      'Message rejected because its digital signature could not be verified.',
    ],
  ])(
    'rejects requests when delivery ack code %s is returned',
    async (code, message) => {
      const manager = createManager();
      const mocks = getCoreMocks();

      mocks.generateId.mockReturnValueOnce('listener-recipient');
      mocks.generateId.mockReturnValueOnce(`ack-${code}`);
      mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });

      const promise = manager.invoke({
        capabilities: ['cap'],
        method: 'call',
        params: {},
      });

      await flushAsync();

      await (manager as any).handleReplyEnvelope({
        id: `reply-${code}`,
        corrId: `ack-${code}`,
        frame: {
          type: 'DeliveryAck',
          code,
        },
      });

      await flushAsync();

      await expect(promise).rejects.toThrow(message as string);
    }
  );

  it('ends streaming iterator when delivery ack has custom code', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('ack-stream');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });

    const iterator = (await manager.invokeStream({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
    })) as AsyncIterableIterator<unknown>;

    await flushAsync();

    await (manager as any).handleReplyEnvelope({
      id: 'reply-ack-stream',
      corrId: 'ack-stream',
      frame: {
        type: 'DeliveryAck',
        code: 'other_code',
        reason: 'failure',
      },
    });

    await flushAsync();

    await expect(iterator.next()).rejects.toThrow(
      "Message delivery failed with code 'other_code': failure"
    );
  });

  it('logs when reply envelope lacks correlation id', async () => {
    const manager = createManager();

    await (manager as any).handleReplyEnvelope({
      id: undefined,
      frame: { type: 'Data', payload: {} },
    });

    expect(loggerInstance.warning).toHaveBeenCalledWith(
      'reply_envelope_missing_corr_id',
      expect.objectContaining({ envelope_id: undefined })
    );
  });

  it('logs when no pending request matches the reply', async () => {
    const manager = createManager();

    await (manager as any).handleReplyEnvelope({
      id: 'no-match',
      corrId: 'no-match',
      frame: { type: 'Data', payload: {} },
    });

    expect(loggerInstance.debug).toHaveBeenCalledWith(
      'no_pending_request_for_reply',
      expect.objectContaining({ request_id: 'no-match' })
    );
  });

  it('cleans up pending entries on cleanup call', async () => {
    const manager = createManager();

    expect(defaultDeliveryTracker.addEventHandler).toHaveBeenCalledTimes(1);

    const mocks = getCoreMocks();
    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('cleanup-id');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'request' });

    const promise = manager.invoke({
      capabilities: ['cap'],
      method: 'call',
      params: {},
    });

    await flushAsync();

    await manager.cleanup();

    await flushAsync();
    await expect(promise).rejects.toThrow('RPC client cleaned up');
    expect(defaultListenCallback).toHaveBeenCalledTimes(1);
    expect(defaultDeliveryTracker.removeEventHandler).toHaveBeenCalledWith(
      defaultDeliveryTracker.addEventHandler.mock.calls[0][0]
    );
  });

  it('cleans up stream entries even when timers are already cleared', async () => {
    const manager = createManager();
    const mocks = getCoreMocks();

    mocks.generateId.mockReturnValueOnce('listener-recipient');
    mocks.generateId.mockReturnValueOnce('cleanup-stream');
    mocks.makeRequest.mockReturnValueOnce({ payload: 'stream request' });

    const iterator = (await manager.invokeStream({
      capabilities: ['cap'],
      method: 'stream',
      params: {},
    })) as AsyncIterableIterator<unknown>;

    const pendingEntry = (manager as any).pending.get('cleanup-stream');
    expect(pendingEntry).toBeDefined();

    const originalEnd = pendingEntry.end.bind(pendingEntry);
    const endSpy = jest.fn((error?: Error) => originalEnd(error));
    pendingEntry.end = endSpy;
    pendingEntry.timer = null;

    await manager.cleanup();

    expect(endSpy).toHaveBeenCalledTimes(1);
    const [cleanupError] = endSpy.mock.calls[0];
    expect(cleanupError).toBeInstanceOf(Error);
    expect(cleanupError?.message).toBe('RPC client cleaned up');

    await expect(iterator.next()).rejects.toThrow('RPC client cleaned up');
  });
});
