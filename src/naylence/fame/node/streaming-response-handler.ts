import {
  DataFrame,
  EnvelopeFactory,
  FameDeliveryContext,
  FameEnvelope,
  FameMessageResponse,
  makeResponse,
} from '@naylence/core';
import { getLogger } from '../util/logging.js';
import { ResponseContextManager } from './response-context-manager.js';

const logger = getLogger('naylence.fame.node.streaming_response_handler');

type DeliverFn = (
  envelope: FameEnvelope,
  context?: FameDeliveryContext
) => Promise<void>;

type AsyncMaybeIterable<T> = AsyncIterable<T> | AsyncIterator<T>;

type AsyncIteratorCandidate<T> = Partial<AsyncIterator<T>> & {
  [Symbol.asyncIterator]?: () => AsyncIterator<T>;
  __anext__?: () => Promise<IteratorResult<T>>;
};

interface StreamingResponseHandlerOptions {
  deliverWrapper: () => DeliverFn;
  envelopeFactory: EnvelopeFactory;
  responseContextManager: ResponseContextManager;
}

type StreamingResponseHandlerOptionsInput =
  Partial<StreamingResponseHandlerOptions> & {
    deliver_wrapper?: () => DeliverFn;
    envelope_factory?: EnvelopeFactory;
    response_context_manager?: ResponseContextManager;
  };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function pickOption<T>(
  record: Record<string, unknown>,
  primary: string,
  ...aliases: string[]
): T | undefined {
  if (Object.prototype.hasOwnProperty.call(record, primary)) {
    const value = record[primary] as T;
    if (value !== undefined) {
      return value;
    }
  }

  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) {
      const value = record[alias] as T;
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

function normalizeOptions(
  options: StreamingResponseHandlerOptionsInput
): StreamingResponseHandlerOptions {
  if (!isPlainRecord(options)) {
    throw new Error('StreamingResponseHandler options must be an object');
  }

  const record = options as Record<string, unknown>;

  const deliverWrapper = pickOption<() => DeliverFn>(
    record,
    'deliverWrapper',
    'deliver_wrapper'
  );
  const envelopeFactory = pickOption<EnvelopeFactory>(
    record,
    'envelopeFactory',
    'envelope_factory'
  );
  const responseContextManager = pickOption<ResponseContextManager>(
    record,
    'responseContextManager',
    'response_context_manager'
  );

  if (typeof deliverWrapper !== 'function') {
    throw new Error(
      'StreamingResponseHandler requires a deliverWrapper option'
    );
  }
  if (!envelopeFactory) {
    throw new Error(
      'StreamingResponseHandler requires an envelopeFactory option'
    );
  }
  if (!responseContextManager) {
    throw new Error(
      'StreamingResponseHandler requires a responseContextManager option'
    );
  }

  return {
    deliverWrapper,
    envelopeFactory,
    responseContextManager,
  };
}

interface ErrorPayload {
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  if (!isObject(value)) {
    return false;
  }

  const potentialError = (value as { error?: unknown }).error;
  if (!isObject(potentialError)) {
    return false;
  }

  const errorRecord = potentialError as Record<string, unknown>;
  return (
    typeof errorRecord.code === 'number' &&
    typeof errorRecord.message === 'string'
  );
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    !!value &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
  );
}

function isAsyncIterator<T>(value: unknown): value is AsyncIterator<T> {
  return !!value && typeof (value as AsyncIterator<T>).next === 'function';
}

function toAsyncIterable<T>(value: AsyncMaybeIterable<T>): AsyncIterable<T> {
  if (isAsyncIterable(value)) {
    return value;
  }
  if (isAsyncIterator(value)) {
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return value;
      },
    };
  }
  throw new TypeError('Value is not async iterable');
}

export class StreamingResponseHandler {
  private readonly deliverWrapperFactory: () => DeliverFn;
  private readonly envelopeFactory: EnvelopeFactory;
  private readonly responseContextManager: ResponseContextManager;

  constructor(
    deliverWrapper: (() => DeliverFn) | StreamingResponseHandlerOptionsInput,
    envelopeFactory?: EnvelopeFactory,
    responseContextManager?: ResponseContextManager
  ) {
    if (typeof deliverWrapper === 'function') {
      if (!envelopeFactory || !responseContextManager) {
        throw new Error(
          'StreamingResponseHandler requires envelopeFactory and responseContextManager when using positional arguments'
        );
      }
      this.deliverWrapperFactory = deliverWrapper;
      this.envelopeFactory = envelopeFactory;
      this.responseContextManager = responseContextManager;
      return;
    }

    const normalized = normalizeOptions(deliverWrapper);
    this.deliverWrapperFactory = normalized.deliverWrapper;
    this.envelopeFactory = normalized.envelopeFactory;
    this.responseContextManager = normalized.responseContextManager;
  }

  public deliverWrapper(): DeliverFn {
    return this.deliverWrapperFactory();
  }

  isStreamingResult<T = unknown>(
    result: unknown
  ): result is AsyncMaybeIterable<T> {
    if (!isObject(result)) {
      return false;
    }

    const candidate = result as AsyncIteratorCandidate<T>;

    return (
      typeof candidate[Symbol.asyncIterator] === 'function' ||
      typeof candidate.__anext__ === 'function' ||
      isAsyncIterator(candidate as AsyncIterator<T>)
    );
  }

  isStreamingFameMessageResponse(
    result: unknown
  ): result is AsyncMaybeIterable<FameMessageResponse> {
    return this.isStreamingResult<FameMessageResponse>(result);
  }

  async handleStreamingFameMessageResponses(
    responses: AsyncMaybeIterable<FameMessageResponse>,
    requestEnvelope: FameEnvelope,
    requestContext?: FameDeliveryContext
  ): Promise<void> {
    const asyncResponses = toAsyncIterable(responses);

    logger.debug('handling_streaming_fame_message_responses', {
      request_id: requestEnvelope.id,
    });

    for await (const response of asyncResponses) {
      if (!response?.envelope) {
        logger.warning('invalid_streaming_response_type', {
          request_id: requestEnvelope.id,
          actual_type: typeof response,
        });
        continue;
      }

      const responseContext =
        response.context ??
        this.responseContextManager.createResponseContext(
          requestEnvelope,
          requestContext
        );

      this.responseContextManager.ensureResponseMetadata(
        response.envelope,
        requestEnvelope,
        responseContext
      );

      await this.deliver(response.envelope, responseContext);
    }
  }

  async handleStreamingResponse(
    result: AsyncMaybeIterable<unknown>,
    requestEnvelope: FameEnvelope,
    requestContext: FameDeliveryContext | undefined,
    replyTo: string,
    requestId: string
  ): Promise<void> {
    const iterable = toAsyncIterable(result);

    logger.debug('handling_streaming_response', {
      request_id: requestId,
      reply_to: replyTo,
    });

    try {
      for await (const item of iterable) {
        await this.sendRpcResponse(
          item,
          requestEnvelope,
          requestContext,
          replyTo,
          requestId
        );
      }
      await this.sendRpcResponse(
        null,
        requestEnvelope,
        requestContext,
        replyTo,
        requestId
      );
    } catch (error) {
      logger.error('streaming_response_handler_error', {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendRpcResponse(
        {
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        },
        requestEnvelope,
        requestContext,
        replyTo,
        requestId
      );
    }
  }

  private async sendRpcResponse(
    payload: unknown,
    requestEnvelope: FameEnvelope,
    requestContext: FameDeliveryContext | undefined,
    replyTo: string,
    requestId: string
  ): Promise<void> {
    const responsePayload = isErrorPayload(payload)
      ? makeResponse(requestId, undefined, payload.error)
      : makeResponse(requestId, payload);

    const responseEnvelope = this.envelopeFactory.createEnvelope({
      ...(requestEnvelope.traceId ? { traceId: requestEnvelope.traceId } : {}),
      frame: {
        type: 'Data',
        payload: responsePayload,
      } as DataFrame,
      to: replyTo,
      corrId: requestId,
    });

    const responseContext = this.responseContextManager.createResponseContext(
      requestEnvelope,
      requestContext
    );

    this.responseContextManager.ensureResponseMetadata(
      responseEnvelope,
      requestEnvelope,
      responseContext
    );

    logger.debug('sending_streaming_rpc_response', {
      request_id: requestId,
      response_envelope_id: responseEnvelope.id,
      reply_to: replyTo,
      is_terminal: payload === null || payload === undefined,
    });

    await this.deliver(responseEnvelope, responseContext);
  }

  private async deliver(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    await this.deliverWrapperFactory()(envelope, context);
  }
}
