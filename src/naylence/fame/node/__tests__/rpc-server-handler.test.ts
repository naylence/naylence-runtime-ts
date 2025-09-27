import type { EnvelopeFactory, FameDeliveryContext, FameEnvelope } from 'naylence-core';
import * as core from 'naylence-core';
import { RPCServerHandler } from '../rpc-server-handler.js';
import type { ResponseContextManager } from '../response-context-manager.js';
import type { StreamingResponseHandler } from '../streaming-response-handler.js';

describe('RPCServerHandler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createHandler(options?: {
    responseContext?: FameDeliveryContext;
    streamingResult?: (value: unknown) => boolean;
  }) {
    const envelopeFactoryMock = jest.fn((optionsArg: any) => ({
      id: optionsArg?.corrId ? `response-${String(optionsArg.corrId)}` : 'response-envelope',
      ...optionsArg,
    }));
    const envelopeFactory = {
      createEnvelope: envelopeFactoryMock,
    };

    const responseContext =
      options?.responseContext ?? ({ meta: undefined } as unknown as FameDeliveryContext);

    const responseContextManagerMock = {
      createResponseContext: jest.fn().mockReturnValue(responseContext),
      ensureResponseMetadata: jest.fn(),
    };

    const streamingResultMock = jest.fn((value: unknown) => {
      return options?.streamingResult?.(value) ?? false;
    });
    const streamingHandleMock = jest.fn();

    const streamingResponseHandler = {
      isStreamingResult: streamingResultMock,
      handleStreamingResponse: streamingHandleMock,
      deliverWrapper: jest.fn(),
      envelopeFactory: {} as EnvelopeFactory,
      responseContextManager: {} as ResponseContextManager,
      isStreamingFameMessageResponse: jest.fn(),
      handleStreamingFameMessageResponses: jest.fn(),
    } as unknown as StreamingResponseHandler;

    const handler = new RPCServerHandler(
      envelopeFactory as unknown as EnvelopeFactory,
      responseContextManagerMock as unknown as ResponseContextManager,
      streamingResponseHandler
    );

    return {
      handler,
      envelopeFactoryMock,
      envelopeFactory,
      responseContext,
      responseContextManagerMock,
      streamingResultMock,
      streamingHandleMock,
    };
  }

  function createDataEnvelope(
    payload: Record<string, unknown>,
    overrides?: Partial<FameEnvelope>
  ): FameEnvelope {
    return {
      id: overrides?.id ?? 'env-1',
      frame: { type: 'Data', payload } as any,
      replyTo: overrides?.replyTo,
      traceId: overrides?.traceId ?? 'trace-123',
      ...overrides,
    } as FameEnvelope;
  }

  it('returns undefined when frame is not a Data frame', async () => {
    const { handler } = createHandler();
    const parseSpy = jest.spyOn(core, 'parseRequest');
    const envelope = {
      id: 'env-non-data',
      frame: { type: 'NodeAttach' },
    } as FameEnvelope;

    const result = await handler.handleRpcRequest(
      envelope,
      undefined,
      jest.fn(),
      'service'
    );

    expect(result).toBeUndefined();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('swallows parse errors and returns undefined', async () => {
    const { handler } = createHandler();
    const parseSpy = jest
      .spyOn(core, 'parseRequest')
      .mockImplementationOnce(() => {
        throw new Error('bad-request');
      });

    const envelope = createDataEnvelope({ bogus: true });

    const result = await handler.handleRpcRequest(
      envelope,
      undefined,
      jest.fn(),
      'service'
    );

    expect(result).toBeUndefined();
    expect(parseSpy).toHaveBeenCalled();
  });

  it('returns undefined when request id is missing', async () => {
    const { handler } = createHandler();
    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: null,
      method: 'noop',
      params: {},
    } as any);

    const result = await handler.handleRpcRequest(
      createDataEnvelope({ id: null }),
      undefined,
      jest.fn(),
      'service'
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined when reply destination cannot be resolved', async () => {
    const { handler } = createHandler();
    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 'abc',
      method: 'noop',
      params: {},
    } as any);

    const result = await handler.handleRpcRequest(
      createDataEnvelope({ params: {} }),
      undefined,
      jest.fn(),
      'service'
    );

    expect(result).toBeUndefined();
  });

  it('creates a traditional response using reply_to object conversion', async () => {
    const existingMeta = { existing: true } as Record<string, unknown>;
    const { handler, envelopeFactoryMock, responseContext } = createHandler({
      responseContext: { meta: existingMeta } as FameDeliveryContext,
    });

    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 'req-1',
      method: 'echo',
      params: {
        reply_to: {
          toString: () => 'derived-destination',
        },
      },
    } as any);

    const handlerFn = jest.fn(async () => 'ack');

    const result = await handler.handleRpcRequest(
      createDataEnvelope({}),
      undefined,
      handlerFn,
      'service'
    );

    expect(handlerFn).toHaveBeenCalledWith('echo', expect.any(Object));
    expect(result?.envelope.to).toBe('derived-destination');
    expect(envelopeFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'derived-destination', corrId: 'req-1' })
    );
    expect(responseContext.meta).toMatchObject({
      existing: true,
      'message-type': 'response',
      'response-to-id': 'env-1',
    });
  });

  it('omits trace metadata when request envelope lacks trace id and identifier', async () => {
    const { handler, envelopeFactoryMock, responseContext } = createHandler();

    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 'req-trace',
      method: 'noop',
      params: { replyTo: 'no-trace-target' },
    } as any);

    await handler.handleRpcRequest(
      {
        frame: { type: 'Data', payload: {} },
      } as FameEnvelope,
      undefined,
      jest.fn().mockResolvedValueOnce('ok'),
      'service'
    );

    const callArgs = envelopeFactoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('traceId');
    expect(callArgs).toMatchObject({ to: 'no-trace-target', corrId: 'req-trace' });
    expect(responseContext.meta).toMatchObject({ 'message-type': 'response' });
    expect(responseContext.meta).not.toHaveProperty('response-to-id');
  });

  it('returns FameMessageResponse results unchanged', async () => {
    const { handler, streamingHandleMock, streamingResultMock } = createHandler();
    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 'req-2',
      method: 'delegate',
      params: {},
    } as any);

    const messageResponse = {
      envelope: {
        id: 'external-response',
        frame: { type: 'Data', payload: { success: true } },
      } as FameEnvelope,
      context: {} as FameDeliveryContext,
    };

    const result = await handler.handleRpcRequest(
      createDataEnvelope({}, { replyTo: 'direct-channel' }),
      undefined,
      jest.fn().mockResolvedValueOnce(messageResponse),
      'service'
    );

    expect(streamingHandleMock).not.toHaveBeenCalled();
    expect(streamingResultMock).toHaveBeenCalledWith(messageResponse);
    expect(result).toBe(messageResponse);
  });

  it('delegates streaming responses to the streaming handler', async () => {
    const streamResult = { stream: true };
    const { handler, streamingHandleMock, streamingResultMock } = createHandler({
      streamingResult: (value) => value === streamResult,
    });

    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 42,
      method: 'stream',
      params: { replyTo: 'stream-target' },
    } as any);

    const handlerFn = jest.fn().mockResolvedValueOnce(streamResult);

    const result = await handler.handleRpcRequest(
      createDataEnvelope({}),
  ({ originType: 'LOCAL', expectedResponseType: 'NONE' } as unknown as FameDeliveryContext),
      handlerFn,
      'service'
    );

    expect(result).toBeUndefined();
    expect(streamingHandleMock).toHaveBeenCalledWith(
      streamResult,
      expect.objectContaining({ id: 'env-1' }),
      { originType: 'LOCAL', expectedResponseType: 'NONE' },
      'stream-target',
      '42'
    );
    expect(streamingResultMock).toHaveBeenCalledWith(streamResult);
  });

  it('wraps handler errors that provide JSON-RPC error details', async () => {
    const { handler, envelopeFactoryMock, responseContext } = createHandler();
    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 'req-err',
      method: 'fail',
      params: { replyTo: 'error-target' },
    } as any);

    const handlerFn = jest.fn().mockImplementation(() => {
      const error = { code: -32000, message: 'custom', data: { detail: true } };
      throw error;
    });

    const result = await handler.handleRpcRequest(
      createDataEnvelope({}),
  ({ meta: undefined } as unknown as FameDeliveryContext),
      handlerFn,
      'service'
    );

    expect(result).toEqual({
      envelope: expect.any(Object),
      context: responseContext,
    });
    const payload = (envelopeFactoryMock.mock.calls[0]?.[0] as any)?.frame?.payload;
    expect(payload?.error).toMatchObject({ code: -32000, message: 'custom', data: { detail: true } });
    expect(responseContext.meta).toMatchObject({
      'message-type': 'response',
      'response-to-id': 'env-1',
    });
  });

  it('wraps handler errors with a default internal error shape', async () => {
    const { handler, envelopeFactoryMock } = createHandler();
    jest.spyOn(core, 'parseRequest').mockReturnValueOnce({
      id: 'req-generic',
      method: 'fail',
      params: { replyTo: 'error-target' },
    } as any);

    const handlerFn = jest.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    await handler.handleRpcRequest(
      createDataEnvelope({}),
      undefined,
      handlerFn,
      'service'
    );

    const payload = (envelopeFactoryMock.mock.calls[0]?.[0] as any)?.frame?.payload;
    expect(payload?.error).toMatchObject({ code: -32603, message: 'boom' });
  });
});
