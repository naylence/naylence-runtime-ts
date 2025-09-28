import {
  DEFAULT_INVOKE_TIMEOUT_MILLIS,
  DataFrame,
  DeliveryOriginType,
  EnvelopeFactory,
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
  type CreateFameEnvelopeOptions,
  formatAddress,
  generateId,
  makeRequest,
  parseResponse,
  type DeliveryAckFrame,
} from 'naylence-core';
import { getLogger } from '../util/logging.js';
import { currentTraceId } from '../util/envelope-context.js';
import type { DeliveryTracker as BasicDeliveryTracker } from '../delivery/delivery-tracker.js';
import type { FameEnvelopeHandler } from 'naylence-core';

const logger = getLogger('rpc-client-manager');

type DeliverFn = (envelope: FameEnvelope, context?: FameDeliveryContext) => Promise<void>;

type DeliverWrapper = () => DeliverFn;

type ListenCallback = (serviceName: string, handler: FameEnvelopeHandler | null) => Promise<FameAddress>;

type StreamCapableDeliveryTracker = BasicDeliveryTracker & {
  onStreamItem?: (envelopeId: string, envelope: FameEnvelope) => Promise<void> | void;
  onStreamEnd?: (envelopeId: string) => Promise<void> | void;
};

interface PendingRequestBase {
  timer: ReturnType<typeof setTimeout> | null;
  expected: FameResponseType;
}

interface PendingSingleRequest extends PendingRequestBase {
  type: 'single';
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface PendingStreamRequest extends PendingRequestBase {
  type: 'stream';
  push: (value: unknown) => void;
  end: (error?: Error) => void;
  envelopeId: string;
}

type PendingRequest = PendingSingleRequest | PendingStreamRequest;

export class RPCClientManager {
  private readonly pending = new Map<string, PendingRequest>();
  private rpcReplyAddress: FameAddress | null = null;
  private rpcListenerAddress: FameAddress | null = null;
  private rpcBound = false;

  constructor(
    private readonly getPhysicalPath: () => string,
    private readonly getId: () => string,
    private readonly deliverWrapper: DeliverWrapper,
    private readonly envelopeFactory: EnvelopeFactory,
    private readonly listenCallback: ListenCallback,
    private readonly deliveryTracker?: StreamCapableDeliveryTracker
  ) {}

  async invoke(options: {
    targetAddr?: FameAddress;
    capabilities?: string[];
    method: string;
    params: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    const { targetAddr, capabilities, method, params, timeoutMs } = options;

    if (!targetAddr && !capabilities) {
      throw new Error('Either target address or capabilities must be provided');
    }
    if (targetAddr && capabilities) {
      throw new Error('Provide either target address or capabilities, not both');
    }

    await this.ensureReplyListener();

    const requestId = generateId();
    const request = makeRequest(method, params, requestId);

    const frame: DataFrame = {
      type: 'Data',
      payload: request,
    };

    const traceId = currentTraceId();
    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      corrId: requestId,
      responseType: FameResponseType.REPLY,
    };

    if (traceId) {
      envelopeOptions.traceId = traceId;
    }
    if (targetAddr) {
      envelopeOptions.to = targetAddr;
    }
    if (capabilities && capabilities.length > 0) {
      envelopeOptions.capabilities = capabilities;
    }
    if (this.rpcReplyAddress) {
      envelopeOptions.replyTo = this.rpcReplyAddress;
    }

    const envelope = this.envelopeFactory.createEnvelope(envelopeOptions);

    const responsePromise = this.trackPendingRequest({
      requestId,
      timeoutMs: timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS,
      expected: FameResponseType.REPLY,
    });

    await this.sendRpcRequest(requestId, envelope, FameResponseType.REPLY, timeoutMs);

    return responsePromise;
  }

  async invokeStream(options: {
    targetAddr?: FameAddress;
    capabilities?: string[];
    method: string;
    params: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<AsyncIterable<unknown>> {
    const { targetAddr, capabilities, method, params, timeoutMs } = options;

    if (!targetAddr && !capabilities) {
      throw new Error('Either target address or capabilities must be provided');
    }
    if (targetAddr && capabilities) {
      throw new Error('Provide either target address or capabilities, not both');
    }

    await this.ensureReplyListener();

    const requestId = generateId();
    const request = makeRequest(method, params, requestId);

    const frame: DataFrame = {
      type: 'Data',
      payload: request,
    };

    const traceId = currentTraceId();
    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      corrId: requestId,
      responseType: FameResponseType.STREAM,
    };

    if (traceId) {
      envelopeOptions.traceId = traceId;
    }
    if (targetAddr) {
      envelopeOptions.to = targetAddr;
    }
    if (capabilities && capabilities.length > 0) {
      envelopeOptions.capabilities = capabilities;
    }
    if (this.rpcReplyAddress) {
      envelopeOptions.replyTo = this.rpcReplyAddress;
    }

    const envelope = this.envelopeFactory.createEnvelope(envelopeOptions);

    const iterator = this.createStreamIterator(
      requestId,
      envelope.id,
      timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS
    );

    await this.sendRpcRequest(requestId, envelope, FameResponseType.STREAM, timeoutMs);

    return iterator;
  }

  async cleanup(): Promise<void> {
    this.rpcBound = false;
    this.rpcReplyAddress = null;
    this.rpcListenerAddress = null;

    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (pending.type === 'single') {
        pending.reject(new Error('RPC client cleaned up'));
      } else {
        pending.end(new Error('RPC client cleaned up'));
      }
    }

    this.pending.clear();
  }

  private async ensureReplyListener(): Promise<void> {
    if (this.rpcBound) {
      return;
    }

    const recipient = '__rpc__';
    this.rpcReplyAddress = formatAddress(recipient, this.getPhysicalPath());

    const handler: FameEnvelopeHandler = async (envelope) => {
      await this.handleReplyEnvelope(envelope);
      return null;
    };

    this.rpcListenerAddress = await this.listenCallback(recipient, handler);
    this.rpcBound = true;

    logger.debug('rpc_reply_listener_bound', {
      reply_recipient: recipient,
      reply_address: this.rpcReplyAddress?.toString(),
      listener_address: this.rpcListenerAddress?.toString(),
    });
  }

  private trackPendingRequest(params: {
    requestId: string;
    timeoutMs: number;
    expected: FameResponseType;
  }): Promise<unknown> {
    const { requestId, timeoutMs, expected } = params;

    if (this.pending.has(requestId)) {
      throw new Error(`Request ${requestId} is already pending`);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const promise = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout waiting for RPC response ${requestId}`));
      }, timeoutMs);

      const entry: PendingSingleRequest = {
        type: 'single',
        expected,
        timer,
        resolve,
        reject,
      };

      this.pending.set(requestId, entry);
    });

    return promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  private createStreamIterator(
    requestId: string,
    envelopeId: string,
    timeoutMs: number
  ): AsyncIterable<unknown> {
    if (this.pending.has(requestId)) {
      throw new Error(`Request ${requestId} is already pending`);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    type StreamQueueItem =
      | { kind: 'value'; value: unknown }
      | { kind: 'end' }
      | { kind: 'error'; error: Error };

    const queue: StreamQueueItem[] = [];
    let pendingResolver: {
      resolve: (value: IteratorResult<unknown>) => void;
      reject: (error: unknown) => void;
    } | null = null;
    let completed = false;

    const deliverNext = () => {
      if (!pendingResolver || queue.length === 0) {
        return;
      }

      const item = queue.shift()!;
      const resolver = pendingResolver;
      pendingResolver = null;

      if (item.kind === 'value') {
        resolver.resolve({ value: item.value, done: false });
        return;
      }

      completed = true;
      if (item.kind === 'end') {
        resolver.resolve({ value: undefined, done: true });
        return;
      }

      resolver.reject(item.error);
    };

    const push = (value: unknown): void => {
      if (completed) {
        return;
      }
      queue.push({ kind: 'value', value });
      deliverNext();
    };

    const end = (error?: Error): void => {
      if (completed) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      if (error) {
        queue.push({ kind: 'error', error });
      } else {
        queue.push({ kind: 'end' });
      }
      deliverNext();
      completed = true;
      this.pending.delete(requestId);
      const finalizePromise = this.notifyStreamClosed(envelopeId);
      if (finalizePromise) {
        finalizePromise.catch((notifyError) => {
          logger.debug('stream_tracker_finalize_failed', {
            request_id: requestId,
            envelope_id: envelopeId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        });
      }
    };

    timer = setTimeout(() => {
      end(new Error(`Timeout waiting for streaming RPC response ${requestId}`));
    }, timeoutMs);

    const entry: PendingStreamRequest = {
      type: 'stream',
      expected: FameResponseType.STREAM,
      timer,
      push,
      end,
      envelopeId,
    };

    this.pending.set(requestId, entry);

    const iterator = {
      next: (): Promise<IteratorResult<unknown>> => {
        if (queue.length > 0) {
          const item = queue.shift()!;
          if (item.kind === 'value') {
            return Promise.resolve({ value: item.value, done: false });
          }

          completed = true;
          if (item.kind === 'end') {
            return Promise.resolve({ value: undefined, done: true });
          }

          return Promise.reject(item.error);
        }

        if (completed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<unknown>>((resolve, reject) => {
          pendingResolver = { resolve, reject };
        });
      },
      return: (): Promise<IteratorResult<unknown>> => {
        end();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error?: unknown): Promise<IteratorResult<unknown>> => {
        const err = error instanceof Error ? error : new Error(String(error ?? 'Stream aborted'));
        end(err);
        return Promise.reject(err);
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
        return this;
      },
    };

    return iterator;
  }

  private async sendRpcRequest(
    requestId: string,
    envelope: FameEnvelope,
    expectedResponseType: FameResponseType,
    timeoutMs?: number
  ): Promise<void> {
    logger.debug('sending_rpc_request', {
      envp_id: envelope.id,
      corr_id: envelope.corrId,
      request_id: requestId,
      target_address: envelope.to,
      expected_response_type: expectedResponseType,
    });

    try {
      if (this.deliveryTracker && 'track' in this.deliveryTracker) {
        await this.deliveryTracker.track(envelope, {
          timeoutMs: timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS,
          expectedResponseType,
        });
      }
    } catch (error) {
      logger.warning('delivery_tracker_track_failed', {
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const context: FameDeliveryContext = {
      originType: DeliveryOriginType.LOCAL,
      fromSystemId: this.getId(),
      expectedResponseType,
    };

    await this.deliverWrapper()(envelope, context);
  }
  private async handleReplyEnvelope(envelope: FameEnvelope): Promise<void> {
    const requestId = envelope.corrId ?? envelope.id;
    if (!requestId) {
      logger.warning('reply_envelope_missing_corr_id', {
        envelope_id: envelope.id,
      });
      return;
    }

    const entry = this.pending.get(requestId);
    if (!entry) {
      logger.debug('no_pending_request_for_reply', {
        request_id: requestId,
      });
      return;
    }

    logger.debug('handle_reply_envelope', {
      envelope_id: envelope.id,
      request_id: requestId,
      corr_id: envelope.corrId,
      frame_type: envelope.frame?.['type'],
      entry_type: entry.type,
    });

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (envelope.frame && (envelope.frame as DeliveryAckFrame).type === 'DeliveryAck') {
      const frame = envelope.frame as DeliveryAckFrame;
      const errorMessage = this.createDeliveryErrorMessage(frame.code, frame.reason);
      const error = new Error(errorMessage);
      if (entry.type === 'single') {
        this.pending.delete(requestId);
        entry.reject(error);
      } else {
        entry.end(error);
      }
      return;
    }

    if (!this.isDataFrame(envelope.frame)) {
      logger.warning('unexpected_reply_frame_type', {
        request_id: requestId,
        frame_type: envelope.frame?.['type'],
      });
      if (entry.type === 'single') {
        this.pending.delete(requestId);
        entry.reject(new Error('Unexpected frame type in reply'));
      } else {
        entry.end(new Error('Unexpected frame type in reply'));
      }
      return;
    }

    try {
      const response = parseResponse(envelope.frame.payload);
      if (response.error) {
        const error = new Error(response.error.message ?? 'RPC error');
        if (entry.type === 'single') {
          this.pending.delete(requestId);
          entry.reject(error);
        } else {
          entry.end(error);
        }
        return;
      }

      if (entry.type === 'single') {
        this.pending.delete(requestId);
        entry.resolve(response.result);
        return;
      }

      if (response.result === null || response.result === undefined) {
        this.forwardStreamItem(entry.envelopeId, envelope);
        entry.end();
        return;
      }

      entry.push(response.result);
      this.forwardStreamItem(entry.envelopeId, envelope);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (entry.type === 'single') {
        this.pending.delete(requestId);
        entry.reject(err);
      } else {
        entry.end(err);
      }
    }
  }

  private forwardStreamItem(envelopeId: string, envelope: FameEnvelope): void {
    if (!this.deliveryTracker || typeof this.deliveryTracker.onStreamItem !== 'function') {
      return;
    }
    Promise.resolve(this.deliveryTracker.onStreamItem(envelopeId, envelope)).catch((error) => {
      logger.debug('stream_tracker_push_failed', {
        envelope_id: envelopeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private notifyStreamClosed(envelopeId: string): Promise<void> | null {
    if (!this.deliveryTracker || typeof this.deliveryTracker.onStreamEnd !== 'function') {
      return null;
    }
    return Promise.resolve(this.deliveryTracker.onStreamEnd(envelopeId));
  }

  private isDataFrame(frame: unknown): frame is DataFrame {
    return typeof frame === 'object' && frame !== null && (frame as DataFrame).type === 'Data';
  }

  private createDeliveryErrorMessage(code?: string, reason?: string): string {
    if (code === 'crypto_level_violation') {
      return 'Message rejected due to insufficient encryption.';
    }
    if (code === 'signature_required') {
      return 'Message rejected because it lacks a required digital signature.';
    }
    if (code === 'signature_verification_failed') {
      return 'Message rejected because its digital signature could not be verified.';
    }
    return `Message delivery failed with code '${code ?? 'unknown'}'${reason ? `: ${reason}` : ''}`;
  }
}
