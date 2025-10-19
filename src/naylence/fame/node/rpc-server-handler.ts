import {
  DataFrame,
  EnvelopeFactory,
  FameDeliveryContext,
  FameEnvelope,
  FameMessageResponse,
  FameRPCHandler,
  JSONRPCError,
  makeResponse,
  parseRequest,
} from 'naylence-core';
import { getLogger } from '../util/logging.js';
import { ResponseContextManager } from './response-context-manager.js';
import { StreamingResponseHandler } from './streaming-response-handler.js';
import { isFameMessageResponse } from 'naylence-core';

const logger = getLogger('naylence.fame.node.rpc_server_handler');

type RpcHandlerResult = FameMessageResponse | unknown;

export class RPCServerHandler {
  constructor(
    private readonly envelopeFactory: EnvelopeFactory,
    private readonly responseContextManager: ResponseContextManager,
    private readonly streamingResponseHandler: StreamingResponseHandler
  ) {}

  async handleRpcRequest(
    envelope: FameEnvelope,
    handlerContext: FameDeliveryContext | undefined,
    handler: FameRPCHandler,
    serviceName: string
  ): Promise<FameMessageResponse | void> {
    if (!this.isDataFrame(envelope.frame)) {
      logger.warning('rpc_request_missing_data_frame', {
        service_name: serviceName,
        envelope_id: envelope.id,
      });
      return;
    }

    logger.debug('rpc_request_received', {
      service_name: serviceName,
      envelope_id: envelope.id,
      trace_id: envelope.traceId,
      reply_to: envelope.replyTo,
    });

    let request: ReturnType<typeof parseRequest>;
    try {
      request = parseRequest(envelope.frame.payload);
      logger.debug('parsed_rpc_request', {
        service_name: serviceName,
        method: request.method,
        request_id: request.id,
        envelope_id: envelope.id,
        params_keys: request.params ? Object.keys(request.params) : undefined,
      });
    } catch (error) {
      logger.warning('request_decode_error', {
        service_name: serviceName,
        envelope_id: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (request.id == null) {
      logger.warning('request_missing_id', {
        service_name: serviceName,
        envelope_id: envelope.id,
      });
      return;
    }

    const params = (request.params ?? {}) as Record<string, unknown>;
    const replyTo = this.resolveReplyTo(envelope, params);
    if (!replyTo) {
      logger.warning('missing_reply_to', {
        service_name: serviceName,
        envelope_id: envelope.id,
        request_id: request.id,
      });
      return;
    }

    let handlerResult: RpcHandlerResult;
    try {
      logger.debug('calling_rpc_handler', {
        service_name: serviceName,
        method: request.method,
        request_id: request.id,
      });
      handlerResult = await handler(request.method, params);
      logger.debug('rpc_handler_returned', {
        service_name: serviceName,
        method: request.method,
        request_id: request.id,
        result_type: handlerResult === null ? 'null' : typeof handlerResult,
        is_streaming:
          this.streamingResponseHandler.isStreamingResult(handlerResult),
      });
    } catch (error) {
      logger.error('rpc_handler_error', {
        service_name: serviceName,
        request_id: request.id,
        envelope_id: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const response = makeResponse(
        request.id,
        undefined,
        this.toJsonRpcError(error)
      );
      return this.createTraditionalResponse(
        response,
        request.id,
        envelope,
        replyTo,
        handlerContext,
        serviceName
      );
    }

    if (isFameMessageResponse(handlerResult)) {
      logger.debug('returning_response_message', {
        service_name: serviceName,
        request_id: request.id,
        response_envelope_id: handlerResult.envelope.id,
      });
      return handlerResult;
    }

    if (this.streamingResponseHandler.isStreamingResult(handlerResult)) {
      logger.debug('handling_streaming_response', {
        service_name: serviceName,
        request_id: request.id,
        envelope_id: envelope.id,
      });
      await this.streamingResponseHandler.handleStreamingResponse(
        handlerResult,
        envelope,
        handlerContext,
        replyTo,
        String(request.id)
      );
      return;
    }

    const response = makeResponse(request.id, handlerResult as unknown);
    return this.createTraditionalResponse(
      response,
      request.id,
      envelope,
      replyTo,
      handlerContext,
      serviceName
    );
  }

  private resolveReplyTo(
    envelope: FameEnvelope,
    params: Record<string, unknown>
  ): string | null | undefined {
    if (envelope.replyTo) {
      return envelope.replyTo as string;
    }
    const value = params?.reply_to ?? params?.replyTo;
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && value !== null && 'toString' in value) {
      return String(value);
    }
    return null;
  }

  private async createTraditionalResponse(
    payload: unknown,
    requestId: string | number,
    requestEnvelope: FameEnvelope,
    replyTo: string,
    handlerContext: FameDeliveryContext | undefined,
    serviceName: string
  ): Promise<FameMessageResponse> {
    logger.debug('creating_traditional_response_envelope', {
      service_name: serviceName,
      request_id: requestId,
      envelope_id: requestEnvelope.id,
      reply_to: replyTo,
    });

    const frame: DataFrame = {
      type: 'Data',
      payload,
    };

    const responseEnvelope = this.envelopeFactory.createEnvelope({
      ...(requestEnvelope.traceId ? { traceId: requestEnvelope.traceId } : {}),
      frame,
      to: replyTo,
      corrId: String(requestId),
    });

    const responseContext = this.responseContextManager.createResponseContext(
      requestEnvelope,
      handlerContext
    );

    if (!responseContext.meta) {
      responseContext.meta = {};
    }
    responseContext.meta['message-type'] = 'response';
    if (requestEnvelope.id) {
      responseContext.meta['response-to-id'] = requestEnvelope.id;
    }

    logger.debug('returning_traditional_response', {
      service_name: serviceName,
      request_id: requestId,
      envelope_id: requestEnvelope.id,
      response_envelope_id: responseEnvelope.id,
    });

    return {
      envelope: responseEnvelope,
      context: responseContext,
    };
  }

  private isDataFrame(frame: unknown): frame is DataFrame {
    return (
      typeof frame === 'object' &&
      frame !== null &&
      (frame as DataFrame).type === 'Data'
    );
  }

  private toJsonRpcError(error: unknown): JSONRPCError {
    if (error && typeof error === 'object') {
      const maybeError = error as Partial<JSONRPCError> & { message?: string };
      if (maybeError.code && maybeError.message) {
        return {
          code: maybeError.code,
          message: maybeError.message,
          data: maybeError.data,
        } as JSONRPCError;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      code: -32603,
      message,
      data: error instanceof Error ? error.stack : undefined,
    };
  }
}
