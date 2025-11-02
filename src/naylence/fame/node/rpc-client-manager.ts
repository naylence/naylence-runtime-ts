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
} from '@naylence/core';
import { getLogger } from '../util/logging.js';
import { currentTraceId } from '../util/envelope-context.js';
import { formatDeliveryErrorMessage } from '../delivery/delivery-error.js';
import type { DeliveryTracker as BasicDeliveryTracker } from '../delivery/delivery-tracker.js';
import type { DeliveryTrackerEventHandler } from '../delivery/default-delivery-tracker.js';
import type { TrackedEnvelope } from '../delivery/tracked-envelope.js';
import type { FameEnvelopeHandler } from '@naylence/core';

const logger = getLogger('naylence.fame.node.rpc_client_manager');

type DeliverFn = (
  envelope: FameEnvelope,
  context?: FameDeliveryContext
) => Promise<void>;

type DeliverWrapper = () => DeliverFn;

type ListenCallback = (
  serviceName: string,
  handler: FameEnvelopeHandler | null
) => Promise<FameAddress>;

type StreamCapableDeliveryTracker = BasicDeliveryTracker & {
  onStreamItem?: (
    envelopeId: string,
    envelope: FameEnvelope
  ) => Promise<void> | void;
  onStreamEnd?: (envelopeId: string) => Promise<void> | void;
};

type DeliveryTrackerWithEvents = StreamCapableDeliveryTracker & {
  addEventHandler?: (handler: DeliveryTrackerEventHandler) => void;
  removeEventHandler?: (handler: DeliveryTrackerEventHandler) => void;
};

interface PendingRequestBase {
  timer: ReturnType<typeof setTimeout> | null;
  expected: FameResponseType;
  envelopeId: string;
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

type InvokeOptions = {
  targetAddr?: FameAddress;
  capabilities?: string[];
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
};

type InvokeOptionsInput = {
  targetAddr?: FameAddress | null;
  capabilities?: unknown;
  method: string;
  params?: Record<string, unknown> | null;
  timeoutMs?: number | null;
  target_addr?: FameAddress | null;
  timeout_ms?: number | string | null;
};

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
  primary: T | null | undefined,
  record: Record<string, unknown>,
  ...aliases: string[]
): T | undefined {
  if (primary !== undefined && primary !== null) {
    return primary;
  }

  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) {
      const candidate = record[alias] as T | null | undefined;
      if (candidate !== undefined && candidate !== null) {
        return candidate;
      }
    }
  }

  return undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const filtered = value.filter((entry): entry is string => typeof entry === 'string');
  return filtered.length > 0 ? [...filtered] : [];
}

function normalizeTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function coerceParams(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    return { ...value };
  }
  return {};
}

function normalizeInvokeOptions(options: InvokeOptionsInput): InvokeOptions {
  if (!isPlainRecord(options)) {
    throw new Error('RPC invoke options must be a plain object');
  }

  const record = options as Record<string, unknown>;
  const methodValue = record['method'];
  if (typeof methodValue !== 'string' || methodValue.trim().length === 0) {
    throw new Error('RPC invoke options must include a method name');
  }

  const targetAddr = pickOption<FameAddress | null | undefined>(
    record['targetAddr'] as FameAddress | null | undefined,
    record,
    'target_addr'
  );

  const capabilitiesValue = pickOption<unknown>(
    record['capabilities'],
    record,
    'accepted_capabilities'
  );
  const capabilities = coerceStringArray(capabilitiesValue);

  const paramsValue = pickOption<Record<string, unknown> | null | undefined>(
    record['params'] as Record<string, unknown> | null | undefined,
    record,
    'params'
  );
  const params = coerceParams(paramsValue);

  const timeoutValue = pickOption<number | string | null | undefined>(
    record['timeoutMs'] as number | string | null | undefined,
    record,
    'timeout_ms'
  );
  const timeoutMs = normalizeTimeout(timeoutValue);

  return {
    targetAddr: targetAddr ?? undefined,
    capabilities,
    method: methodValue,
    params,
    timeoutMs,
  };
}

export class RPCClientManager {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingByEnvelopeId = new Map<string, string>();
  private rpcReplyAddress: FameAddress | null = null;
  private rpcListenerAddress: FameAddress | null = null;
  private rpcBound = false;
  private trackerEventHandler: DeliveryTrackerEventHandler | null = null;
  private trackerWithEvents: DeliveryTrackerWithEvents | null = null;

  constructor(
    private readonly getPhysicalPath: () => string,
    private readonly getId: () => string,
    private readonly deliverWrapper: DeliverWrapper,
    private readonly envelopeFactory: EnvelopeFactory,
    private readonly listenCallback: ListenCallback,
    private readonly deliveryTracker?: StreamCapableDeliveryTracker
  ) {
    this.setupTrackerEventHandler();
  }

  private setupTrackerEventHandler(): void {
    if (!this.deliveryTracker || typeof this.deliveryTracker !== 'object') {
      return;
    }

    const tracker = this.deliveryTracker as DeliveryTrackerWithEvents;
    if (typeof tracker.addEventHandler !== 'function') {
      return;
    }

    this.trackerEventHandler = {
      onEnvelopeNacked: (tracked, reason) => {
        this.handleDeliveryNack(tracked, reason ?? null);
      },
    } satisfies DeliveryTrackerEventHandler;

    this.trackerWithEvents = tracker;
    tracker.addEventHandler(this.trackerEventHandler);
  }

  async invoke(optionsInput: InvokeOptionsInput): Promise<unknown> {
    const { targetAddr, capabilities, method, params, timeoutMs } =
      normalizeInvokeOptions(optionsInput);

    if (!targetAddr && !capabilities) {
      throw new Error('Either target address or capabilities must be provided');
    }
    if (targetAddr && capabilities) {
      throw new Error(
        'Provide either target address or capabilities, not both'
      );
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
      envelopeId: envelope.id,
      timeoutMs: timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS,
      expected: FameResponseType.REPLY,
    });

    await this.sendRpcRequest(
      requestId,
      envelope,
      FameResponseType.REPLY,
      timeoutMs
    );

    return responsePromise;
  }

  async invokeStream(
    optionsInput: InvokeOptionsInput
  ): Promise<AsyncIterable<unknown>> {
    const { targetAddr, capabilities, method, params, timeoutMs } =
      normalizeInvokeOptions(optionsInput);

    if (!targetAddr && !capabilities) {
      throw new Error('Either target address or capabilities must be provided');
    }
    if (targetAddr && capabilities) {
      throw new Error(
        'Provide either target address or capabilities, not both'
      );
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

    await this.sendRpcRequest(
      requestId,
      envelope,
      FameResponseType.STREAM,
      timeoutMs
    );

    return iterator;
  }

  handleDeliveryNack(tracked: TrackedEnvelope, reason?: string | null): void {
    const envelopeId = tracked.originalEnvelope.id;
    const requestId = this.pendingByEnvelopeId.get(envelopeId);
    if (!requestId) {
      return;
    }

    const pending = this.pending.get(requestId);
    if (!pending) {
      this.pendingByEnvelopeId.delete(envelopeId);
      return;
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    const metaCode = tracked.meta?.['nack_code'];
    const metaReason = tracked.meta?.['nack_reason'];
    const formattedMessage = formatDeliveryErrorMessage(
      typeof metaCode === 'string' ? metaCode : 'DELIVERY_ERROR',
      reason ??
        (typeof metaReason === 'string' ? (metaReason as string) : undefined)
    );

    logger.debug('pending_request_rejected_by_delivery_nack', {
      envelope_id: envelopeId,
      request_id: requestId,
      code: typeof metaCode === 'string' ? metaCode : 'DELIVERY_ERROR',
      reason:
        reason ?? (typeof metaReason === 'string' ? metaReason : undefined),
      entry_type: pending.type,
    });

    this.pending.delete(requestId);
    this.pendingByEnvelopeId.delete(envelopeId);

    const nackError = new Error(formattedMessage);
    if (pending.type === 'single') {
      pending.reject(nackError);
    } else {
      pending.end(nackError);
    }
  }

  async cleanup(): Promise<void> {
    if (this.trackerWithEvents && this.trackerEventHandler) {
      try {
        this.trackerWithEvents.removeEventHandler?.(this.trackerEventHandler);
      } catch (error) {
        logger.debug('rpc_tracker_handler_remove_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.trackerEventHandler = null;
      this.trackerWithEvents = null;
    }

    this.rpcBound = false;
    this.rpcReplyAddress = null;
    this.rpcListenerAddress = null;

    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (pending.type === 'single') {
        pending.reject(new Error('RPC client cleaned up'));
      } else {
        pending.end(new Error('RPC client cleaned up'));
      }
      this.pendingByEnvelopeId.delete(pending.envelopeId);
      this.pending.delete(requestId);
    }

    this.pending.clear();
    this.pendingByEnvelopeId.clear();
  }

  private async ensureReplyListener(): Promise<void> {
    if (this.rpcBound) {
      return;
    }

    const recipient = `__rpc__${generateId()}`;
    this.rpcReplyAddress = formatAddress(recipient, this.getPhysicalPath());

    const handler: FameEnvelopeHandler = async (
      envelope: FameEnvelope,
      _context?: FameDeliveryContext
    ) => {
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
    envelopeId: string;
    timeoutMs: number;
    expected: FameResponseType;
  }): Promise<unknown> {
    const { requestId, envelopeId, timeoutMs, expected } = params;

    if (this.pending.has(requestId)) {
      throw new Error(`Request ${requestId} is already pending`);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const promise = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        const pendingEntry = this.pending.get(requestId);
        if (pendingEntry) {
          this.pending.delete(requestId);
          this.pendingByEnvelopeId.delete(pendingEntry.envelopeId);
        }
        reject(new Error(`Timeout waiting for RPC response ${requestId}`));
      }, timeoutMs);

      const entry: PendingSingleRequest = {
        type: 'single',
        expected,
        timer,
        envelopeId,
        resolve,
        reject,
      };

      this.pending.set(requestId, entry);
      this.pendingByEnvelopeId.set(envelopeId, requestId);
    });

    promise.catch(() => undefined);

    const exposedPromise = promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });

    exposedPromise.catch(() => undefined);

    return exposedPromise;
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
      this.pendingByEnvelopeId.delete(envelopeId);
      const finalizePromise = this.notifyStreamClosed(envelopeId);
      if (finalizePromise) {
        finalizePromise.catch((notifyError) => {
          logger.debug('stream_tracker_finalize_failed', {
            request_id: requestId,
            envelope_id: envelopeId,
            error:
              notifyError instanceof Error
                ? notifyError.message
                : String(notifyError),
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
    this.pendingByEnvelopeId.set(envelopeId, requestId);

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
        const err =
          error instanceof Error
            ? error
            : new Error(String(error ?? 'Stream aborted'));
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
    logger.debug('handle_reply_envelope_received', {
      envelope_id: envelope.id,
      corr_id: envelope.corrId,
      frame_type: envelope.frame?.['type'],
    });
    let requestId = envelope.corrId ?? envelope.id;
    if (!requestId) {
      logger.warning('reply_envelope_missing_corr_id', {
        envelope_id: envelope.id,
      });
      return;
    }

    let entry = this.pending.get(requestId);
    if (
      !entry &&
      envelope.frame &&
      (envelope.frame as DeliveryAckFrame).type === 'DeliveryAck' &&
      (envelope.frame as DeliveryAckFrame).refId
    ) {
      const frame = envelope.frame as DeliveryAckFrame;
      const mappedRequestId = this.pendingByEnvelopeId.get(frame.refId!);
      if (mappedRequestId) {
        requestId = mappedRequestId;
        entry = this.pending.get(mappedRequestId);
      }
    }

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

    if (
      envelope.frame &&
      (envelope.frame as DeliveryAckFrame).type === 'DeliveryAck'
    ) {
      const frame = envelope.frame as DeliveryAckFrame;
      const ackIndicatesSuccess =
        frame.ok === true ||
        (frame.ok === undefined && !frame.code && !frame.reason);

      if (ackIndicatesSuccess) {
        logger.debug('pending_request_delivery_acknowledged', {
          request_id: requestId,
          envelope_id: envelope.id,
          ref_id: frame.refId ?? null,
        });
        return;
      }

      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }

      this.pending.delete(requestId);
      this.pendingByEnvelopeId.delete(entry.envelopeId);

      const errorMessage = formatDeliveryErrorMessage(frame.code, frame.reason);
      const error = new Error(errorMessage);
      if (entry.type === 'single') {
        entry.reject(error);
      } else {
        entry.end(error);
      }
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (!this.isDataFrame(envelope.frame)) {
      logger.warning('unexpected_reply_frame_type', {
        request_id: requestId,
        frame_type: envelope.frame?.['type'],
      });
      if (entry.type === 'single') {
        this.pending.delete(requestId);
        this.pendingByEnvelopeId.delete(entry.envelopeId);
        entry.reject(new Error('Unexpected frame type in reply'));
      } else {
        this.pending.delete(requestId);
        this.pendingByEnvelopeId.delete(entry.envelopeId);
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
          this.pendingByEnvelopeId.delete(entry.envelopeId);
          entry.reject(error);
        } else {
          this.pending.delete(requestId);
          this.pendingByEnvelopeId.delete(entry.envelopeId);
          entry.end(error);
        }
        return;
      }

      if (entry.type === 'single') {
        this.pending.delete(requestId);
        this.pendingByEnvelopeId.delete(entry.envelopeId);
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
        this.pendingByEnvelopeId.delete(entry.envelopeId);
        entry.reject(err);
      } else {
        this.pending.delete(requestId);
        this.pendingByEnvelopeId.delete(entry.envelopeId);
        entry.end(err);
      }
    }
  }

  private forwardStreamItem(envelopeId: string, envelope: FameEnvelope): void {
    if (
      !this.deliveryTracker ||
      typeof this.deliveryTracker.onStreamItem !== 'function'
    ) {
      return;
    }
    Promise.resolve(
      this.deliveryTracker.onStreamItem(envelopeId, envelope)
    ).catch((error) => {
      logger.debug('stream_tracker_push_failed', {
        envelope_id: envelopeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private notifyStreamClosed(envelopeId: string): Promise<void> | null {
    if (
      !this.deliveryTracker ||
      typeof this.deliveryTracker.onStreamEnd !== 'function'
    ) {
      return null;
    }
    return Promise.resolve(this.deliveryTracker.onStreamEnd(envelopeId));
  }

  private isDataFrame(frame: unknown): frame is DataFrame {
    return (
      typeof frame === 'object' &&
      frame !== null &&
      (frame as DataFrame).type === 'Data'
    );
  }
}
