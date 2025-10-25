import {
  makeResponse,
  type EnvelopeFactory,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameMessageResponse,
} from '@naylence/core';
import { StreamingResponseHandler } from '../streaming-response-handler.js';
import type { ResponseContextManager } from '../response-context-manager.js';

describe('StreamingResponseHandler', () => {
  type DeliverFn = (
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ) => Promise<void>;
  let deliverFn: jest.Mock<
    Promise<void>,
    [FameEnvelope, FameDeliveryContext | undefined]
  >;
  let deliverWrapper: jest.Mock<DeliverFn, []>;
  let envelopeFactory: jest.Mocked<EnvelopeFactory>;
  let responseContextManager: jest.Mocked<ResponseContextManager>;
  let handler: StreamingResponseHandler;

  const generatedContext = {
    generated: true,
  } as unknown as FameDeliveryContext;

  beforeEach(() => {
    deliverFn = jest.fn<
      Promise<void>,
      [FameEnvelope, FameDeliveryContext | undefined]
    >(async () => {});
    deliverWrapper = jest.fn<DeliverFn, []>(() => deliverFn);

    envelopeFactory = {
      createEnvelope: jest.fn(
        (options) =>
          ({
            id: `env-${Math.random()}`,
            ...options,
          }) as unknown as FameEnvelope
      ),
    } as unknown as jest.Mocked<EnvelopeFactory>;

    responseContextManager = {
      createResponseContext: jest.fn(() => generatedContext),
      ensureResponseMetadata: jest.fn(),
    } as unknown as jest.Mocked<ResponseContextManager>;

    handler = new StreamingResponseHandler(
      deliverWrapper,
      envelopeFactory,
      responseContextManager
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isStreamingResult', () => {
    it('returns false for non-object inputs', () => {
      expect(handler.isStreamingResult(42)).toBe(false);
      expect(handler.isStreamingFameMessageResponse('not-stream')).toBe(false);
    });

    it('detects streaming result via Symbol.asyncIterator', () => {
      const asyncIterable = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ value: undefined, done: true }),
          };
        },
      };

      expect(handler.isStreamingResult(asyncIterable)).toBe(true);
    });

    it('detects streaming result via __anext__ fallback', () => {
      const pythonStyleIterator = {
        __anext__: async () => ({ value: undefined, done: false }),
      };

      expect(handler.isStreamingResult(pythonStyleIterator)).toBe(true);
    });

    it('detects streaming result via AsyncIterator next()', () => {
      const iterator = {
        next: async () => ({ value: undefined, done: true }),
      };

      expect(handler.isStreamingResult(iterator)).toBe(true);
    });
  });

  describe('handleStreamingFameMessageResponses', () => {
    it('skips invalid responses and forwards valid ones with proper context', async () => {
      const customContext = { custom: true } as unknown as FameDeliveryContext;

      async function* createResponses(): AsyncIterable<FameMessageResponse> {
        yield {} as FameMessageResponse;
        yield {
          envelope: { id: 'resp-with-context' } as FameEnvelope,
          context: customContext,
        } as unknown as FameMessageResponse;
        yield {
          envelope: { id: 'resp-generated-context' } as FameEnvelope,
        } as unknown as FameMessageResponse;
      }

      const requestEnvelope = {
        id: 'req-1',
        frame: { type: 'Data', payload: 'payload' },
      } as unknown as FameEnvelope;
      const requestContext = {
        origin: 'origin',
      } as unknown as FameDeliveryContext;

      await handler.handleStreamingFameMessageResponses(
        createResponses(),
        requestEnvelope,
        requestContext
      );

      expect(deliverFn).toHaveBeenCalledTimes(2);
      expect(deliverWrapper).toHaveBeenCalledTimes(2);
      expect(
        responseContextManager.ensureResponseMetadata
      ).toHaveBeenCalledTimes(2);
      expect(
        responseContextManager.createResponseContext
      ).toHaveBeenCalledTimes(1);

      expect(deliverFn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'resp-with-context' }),
        customContext
      );
      expect(deliverFn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'resp-generated-context' }),
        generatedContext
      );
    });
  });

  describe('handleStreamingResponse', () => {
    it('sends each chunk and a final null response when iteration completes', async () => {
      const iteratorValues = ['chunk-1', 'chunk-2'];
      let idx = 0;
      const iterator = {
        next: jest.fn(() => {
          if (idx < iteratorValues.length) {
            return Promise.resolve({
              value: iteratorValues[idx++],
              done: false,
            });
          }
          return Promise.resolve({ value: undefined, done: true });
        }),
      } as AsyncIterator<unknown>;

      const sendSpy = jest.spyOn(
        handler as unknown as { sendRpcResponse: jest.Mock },
        'sendRpcResponse'
      );
      sendSpy.mockResolvedValue(undefined);

      const requestEnvelope = {
        id: 'req-iter',
        frame: { type: 'Data', payload: null },
      } as unknown as FameEnvelope;
      const requestContext = { ctx: true } as unknown as FameDeliveryContext;

      await handler.handleStreamingResponse(
        iterator,
        requestEnvelope,
        requestContext,
        'reply-to',
        'request-123'
      );

      expect(iterator.next).toHaveBeenCalledTimes(iteratorValues.length + 1);
      expect(sendSpy).toHaveBeenNthCalledWith(
        1,
        'chunk-1',
        requestEnvelope,
        requestContext,
        'reply-to',
        'request-123'
      );
      expect(sendSpy).toHaveBeenNthCalledWith(
        2,
        'chunk-2',
        requestEnvelope,
        requestContext,
        'reply-to',
        'request-123'
      );
      expect(sendSpy).toHaveBeenNthCalledWith(
        3,
        null,
        requestEnvelope,
        requestContext,
        'reply-to',
        'request-123'
      );

      sendSpy.mockRestore();
    });

    it('sends error payload when iteration throws an Error', async () => {
      const error = new Error('stream failed');
      const iterable = {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next: () => Promise.reject(error),
          };
        },
      };

      const sendSpy = jest.spyOn(
        handler as unknown as { sendRpcResponse: jest.Mock },
        'sendRpcResponse'
      );
      sendSpy.mockResolvedValue(undefined);

      await handler.handleStreamingResponse(
        iterable,
        {
          id: 'req-error',
          frame: { type: 'Data', payload: null },
        } as unknown as FameEnvelope,
        undefined,
        'reply-to',
        'req-error'
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        {
          error: {
            code: -32000,
            message: 'stream failed',
          },
        },
        expect.any(Object),
        undefined,
        'reply-to',
        'req-error'
      );

      sendSpy.mockRestore();
    });

    it('sends error payload using stringified message when iteration throws non-error', async () => {
      const iterable = {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return {
            next: () => Promise.reject('plain failure'),
          };
        },
      };

      const sendSpy = jest.spyOn(
        handler as unknown as { sendRpcResponse: jest.Mock },
        'sendRpcResponse'
      );
      sendSpy.mockResolvedValue(undefined);

      await handler.handleStreamingResponse(
        iterable,
        {
          id: 'req-string',
          frame: { type: 'Data', payload: null },
        } as unknown as FameEnvelope,
        undefined,
        'reply-to',
        'req-string'
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        {
          error: {
            code: -32000,
            message: 'plain failure',
          },
        },
        expect.any(Object),
        undefined,
        'reply-to',
        'req-string'
      );

      sendSpy.mockRestore();
    });
  });

  describe('sendRpcResponse', () => {
    it('creates error responses with trace metadata', async () => {
      const requestEnvelope = {
        id: 'req-id',
        traceId: 'trace-1',
        frame: { type: 'Data', payload: null },
      } as unknown as FameEnvelope;
      const requestContext = { parent: true } as unknown as FameDeliveryContext;

      const responseEnvelope = {
        id: 'response-env',
      } as unknown as FameEnvelope;
      envelopeFactory.createEnvelope.mockReturnValue(responseEnvelope);

      const errorPayload = {
        code: 42,
        message: 'boom',
        data: { detail: true },
      };

      await (
        handler as unknown as { sendRpcResponse: Function }
      ).sendRpcResponse(
        { error: errorPayload },
        requestEnvelope,
        requestContext,
        'reply-target',
        'req-id'
      );

      const expectedPayload = makeResponse('req-id', undefined, errorPayload);

      expect(envelopeFactory.createEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-1',
          frame: expect.objectContaining({
            payload: expectedPayload,
          }),
          to: 'reply-target',
          corrId: 'req-id',
        })
      );

      expect(responseContextManager.createResponseContext).toHaveBeenCalledWith(
        requestEnvelope,
        requestContext
      );
      expect(
        responseContextManager.ensureResponseMetadata
      ).toHaveBeenCalledWith(
        responseEnvelope,
        requestEnvelope,
        generatedContext
      );
      expect(deliverWrapper).toHaveBeenCalledTimes(1);
      expect(deliverFn).toHaveBeenCalledWith(
        responseEnvelope,
        generatedContext
      );
    });

    it('creates success responses without optional metadata', async () => {
      const requestEnvelope = {
        id: 'req-2',
        frame: { type: 'Data', payload: null },
      } as unknown as FameEnvelope;
      const responseEnvelope = {
        id: 'response-env-2',
      } as unknown as FameEnvelope;
      envelopeFactory.createEnvelope.mockReturnValue(responseEnvelope);

      await (
        handler as unknown as { sendRpcResponse: Function }
      ).sendRpcResponse(
        { result: 'value' },
        requestEnvelope,
        undefined,
        'reply-other',
        'req-2'
      );

      const expectedPayload = makeResponse('req-2', { result: 'value' });

      expect(envelopeFactory.createEnvelope).toHaveBeenCalledWith(
        expect.not.objectContaining({ traceId: expect.anything() })
      );
      expect(envelopeFactory.createEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          frame: expect.objectContaining({ payload: expectedPayload }),
          to: 'reply-other',
          corrId: 'req-2',
        })
      );
      expect(responseContextManager.createResponseContext).toHaveBeenCalledWith(
        requestEnvelope,
        undefined
      );
      expect(deliverFn).toHaveBeenCalledWith(
        responseEnvelope,
        generatedContext
      );
    });
  });
});
