import {
  DataFrame,
  EnvelopeFactory,
  FameDeliveryContext,
  FameEnvelope,
  FameMessageResponse,
  makeResponse,
} from 'naylence-core';
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  constructor(
    private readonly deliverWrapper: () => DeliverFn,
    private readonly envelopeFactory: EnvelopeFactory,
    private readonly responseContextManager: ResponseContextManager
  ) {}

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

      await this.deliverWrapper()(response.envelope, responseContext);
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

    await this.deliverWrapper()(responseEnvelope, responseContext);
  }
}
