import {
  DEFAULT_POLLING_TIMEOUT_MS,
  FameDeliveryContext,
  FameEnvelope,
  FameEnvelopeHandler,
  FameMessageResponse,
  extractEnvelopeAndContext,
  isFameMessageResponse,
  type FameBindingChannelMessage,
} from "naylence-core";
import { getLogger } from "../util/logging.js";
import { withEnvelopeContextAsync } from "../util/envelope-context.js";
import { FameTransportClose } from "../errors/errors.js";
import type { ReadWriteChannel } from "naylence-core";
import type { ResponseContextManager } from "./response-context-manager.js";
import { StreamingResponseHandler } from "./streaming-response-handler.js";
import { TaskTimeoutError } from "../util/task-types.js";

const logger = getLogger("channel-polling-manager");

type DeliverFn = (envelope: FameEnvelope, context?: FameDeliveryContext) => Promise<void>;

type DeliverWrapper = () => DeliverFn;

interface StopState {
  stopped: boolean;
}

export class ChannelPollingManager {
  constructor(
    private readonly deliverWrapper: DeliverWrapper,
    private readonly responseContextManager: ResponseContextManager,
    private readonly streamingResponseHandler: StreamingResponseHandler
  ) {}

  async startPollingLoop(
    serviceName: string,
    channel: ReadWriteChannel,
    handler: FameEnvelopeHandler,
    stopState: StopState,
    pollTimeoutMs: number | undefined = DEFAULT_POLLING_TIMEOUT_MS
  ): Promise<void> {
    logger.debug("poll_loop_started", {
      recipient: serviceName,
    });

    try {
      let draining = false;

      while (true) {
        if (stopState.stopped && !draining) {
          draining = true;
          logger.debug("poll_loop_draining_pending_messages", {
            recipient: serviceName,
          });
        }

        let message: unknown;
        try {
          message = await channel.receive(pollTimeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS);
        } catch (error) {
          if (error instanceof FameTransportClose) {
            logger.debug("channel_closed", {
              recipient: serviceName,
              message: error.message,
            });
            break;
          }

          if (error instanceof TaskTimeoutError) {
            if (stopState.stopped) {
              break;
            }
            continue;
          }

          if (error instanceof Error && error.name === "AbortError") {
            logger.debug("listener_cancelled", {
              recipient: serviceName,
            });
            throw error;
          }

          if (error instanceof Error && error.name === "TimeoutError") {
            if (stopState.stopped) {
              break;
            }
            continue;
          }

          if (error instanceof Error && error.message === "Channel is closed") {
            logger.debug("channel_closed", {
              recipient: serviceName,
            });
            break;
          }

          if (error instanceof Error && error.name === "TaskCancelledError") {
            logger.debug("listener_cancelled", {
              recipient: serviceName,
            });
            throw error;
          }

          if (error instanceof Error && error.message.includes("Timeout")) {
            if (stopState.stopped) {
              break;
            }
            continue;
          }

          if (error instanceof Error && error.message.includes("closed")) {
            logger.debug("channel_closed", {
              recipient: serviceName,
            });
            break;
          }

          logger.error("transport_error", {
            recipient: serviceName,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }

        if (message == null) {
          if (stopState.stopped) {
            break;
          }

          continue;
        }

        await this.processChannelMessage(message, handler, serviceName);
      }
    } finally {
      logger.debug("poll_loop_exiting", {
        recipient: serviceName,
      });
    }
  }

  private async processChannelMessage(
    message: unknown,
    handler: FameEnvelopeHandler,
    serviceName: string
  ): Promise<void> {
    const [envelope, deliveryContext] = extractEnvelopeAndContext(
      message as FameBindingChannelMessage
    );

    await withEnvelopeContextAsync(envelope, async () => {
      try {
        const result = await handler(envelope, deliveryContext);
        await this.processHandlerResult(result, envelope, deliveryContext, serviceName);
      } catch (error) {
        logger.error("handler_crashed", {
          recipient: serviceName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  private async processHandlerResult(
    result: unknown,
    envelope: FameEnvelope,
    context: FameDeliveryContext | undefined,
    serviceName: string
  ): Promise<void> {
    if (isFameMessageResponse(result)) {
      await this.handleMessageResponse(result, envelope, context, serviceName);
      return;
    }

    if (this.streamingResponseHandler.isStreamingFameMessageResponse(result)) {
      logger.debug("handling_streaming_fame_message_responses", {
        service_name: serviceName,
        envelope_id: envelope.id,
      });
      await this.streamingResponseHandler.handleStreamingFameMessageResponses(
        result,
        envelope,
        context
      );
    }
  }

  private async handleMessageResponse(
    response: FameMessageResponse,
    requestEnvelope: FameEnvelope,
    requestContext: FameDeliveryContext | undefined,
    serviceName: string
  ): Promise<void> {
    logger.debug("delivering_envelope_response_message", {
      service_name: serviceName,
      response_envelope_id: response.envelope.id,
    });

    const responseContext =
      response.context ??
      this.responseContextManager.createResponseContext(requestEnvelope, requestContext);

    this.responseContextManager.ensureResponseMetadata(
      response.envelope,
      requestEnvelope,
      responseContext
    );

    await this.deliverWrapper()(response.envelope, responseContext);
  }
}
