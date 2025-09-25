import {
  DEFAULT_INVOKE_TIMEOUT_MILLIS,
  DEFAULT_POLLING_TIMEOUT_MS,
  Binding,
  EnvelopeFactory,
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameEnvelopeHandler,
  FameMessageResponse,
  FameRPCHandler,
} from 'naylence-core';
import { getLogger } from '../util/logging.js';
import { TaskSpawner } from '../util/task-spawner.js';
import type { SpawnedTask } from '../util/task-types.js';
import { BindingManager } from './binding-manager.js';
import type { NodeLike } from './node-like.js';
import { ResponseContextManager } from './response-context-manager.js';
import { StreamingResponseHandler } from './streaming-response-handler.js';
import { ChannelPollingManager } from './channel-polling-manager.js';
import { RPCServerHandler } from './rpc-server-handler.js';
import { RPCClientManager } from './rpc-client-manager.js';
import type { DefaultDeliveryTracker } from '../delivery/default-delivery-tracker.js';
import type { DeliveryTracker as BasicDeliveryTracker } from '../delivery/delivery-tracker.js';
import { EnvelopeStatus, TrackedEnvelope } from '../delivery/tracked-envelope.js';
import type { RetryPolicy } from '../delivery/retry-policy.js';

const logger = getLogger('envelope-listener-manager');

type DeliverFn = (envelope: FameEnvelope, context?: FameDeliveryContext) => Promise<void>;

class AsyncMutex {
  private cursor: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const wait = this.cursor;
    this.cursor = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class EnvelopeListener {
  constructor(private readonly stopFn: () => void, public readonly task: SpawnedTask<void>) {}

  stop(): void {
    logger.debug('stopping_listener', {
      task_name: this.task.name,
    });
    this.stopFn();
    this.task.cancel();
  }
}

interface RegisteredListener {
  readonly handler: FameEnvelopeHandler | null;
  readonly listener: EnvelopeListener;
  readonly binding: Binding;
}

interface ListenOptions {
  capabilities?: string[] | null;
  pollTimeoutMs?: number | null;
}

type RecoveryCache = Map<string, TrackedEnvelope[]>;

export class EnvelopeListenerManager extends TaskSpawner {
  private readonly bindingManager: BindingManager;
  private readonly nodeLike: NodeLike;
  private readonly envelopeFactory: EnvelopeFactory;
  private readonly deliveryTracker: DefaultDeliveryTracker;

  private readonly deliver: DeliverFn;

  private readonly listeners = new Map<string, RegisteredListener>();
  private readonly listenersLock = new AsyncMutex();

  private readonly serviceHandlers = new Map<string, FameEnvelopeHandler>();
  private readonly serviceHandlersLock = new AsyncMutex();

  private readonly pendingRecoveryServices = new Set<string>();
  private readonly pendingRecoveryEnvelopes: RecoveryCache = new Map();
  private readonly pendingRecoveryLock = new AsyncMutex();

  private readonly serviceRecoveryLocks = new Map<string, AsyncMutex>();
  private readonly serviceRecoveryLocksLock = new AsyncMutex();

  private readonly responseContextManager: ResponseContextManager;
  private readonly streamingResponseHandler: StreamingResponseHandler;
  private readonly channelPollingManager: ChannelPollingManager;
  private readonly rpcServerHandler: RPCServerHandler;
  private readonly rpcClientManager: RPCClientManager;

  constructor(options: {
    bindingManager: BindingManager;
    nodeLike: NodeLike;
    envelopeFactory: EnvelopeFactory;
    deliveryTracker: DefaultDeliveryTracker;
  }) {
    super();

    this.bindingManager = options.bindingManager;
    this.nodeLike = options.nodeLike;
    this.envelopeFactory = options.envelopeFactory;
    this.deliveryTracker = options.deliveryTracker;

    this.deliver = async (envelope, context) => {
      await this.nodeLike.send(envelope, context);
    };

    this.responseContextManager = new ResponseContextManager(() => this.nodeLike.id);

    this.streamingResponseHandler = new StreamingResponseHandler(
      () => this.deliver,
      this.envelopeFactory,
      this.responseContextManager
    );

    this.channelPollingManager = new ChannelPollingManager(
      () => this.deliver,
      this.responseContextManager,
      this.streamingResponseHandler
    );

    this.rpcServerHandler = new RPCServerHandler(
      this.envelopeFactory,
      this.responseContextManager,
      this.streamingResponseHandler
    );

    const deliveryTrackerAdapter = this.deliveryTracker as unknown as BasicDeliveryTracker;

    this.rpcClientManager = new RPCClientManager(
      () => this.nodeLike.physicalPath,
      () => this.nodeLike.id,
      () => this.deliver,
      this.envelopeFactory,
      (serviceName, handler) => this.listen(serviceName, handler ?? undefined),
      deliveryTrackerAdapter
    );
  }

  async start(): Promise<void> {
    await this.recoverUnhandledInboundEnvelopes();
  }

  async stop(): Promise<void> {
    await this.listenersLock.runExclusive(async () => {
      for (const [serviceName, entry] of this.listeners.entries()) {
        logger.debug('stopping_listener_for_service', { service_name: serviceName });
        entry.listener.stop();
        try {
          await entry.listener.task.promise;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'TaskCancelledError') {
            logger.debug('listener_task_stopped', {
              service_name: serviceName,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      this.listeners.clear();
    });

    await this.serviceHandlersLock.runExclusive(async () => {
      this.serviceHandlers.clear();
    });

    await this.rpcClientManager.cleanup();
    await this.shutdownTasks({ gracePeriod: 3000 });
  }

  async recoverUnhandledInboundEnvelopes(): Promise<void> {
    if (typeof this.deliveryTracker.listInbound !== 'function') {
      logger.debug('delivery_tracker_missing_inbound_listing');
      return;
    }

    const failedInbound = await this.deliveryTracker.listInbound((env) =>
      env.status === EnvelopeStatus.RECEIVED || env.status === EnvelopeStatus.FAILED_TO_HANDLE
    );

    if (!failedInbound.length) {
      logger.debug('no_failed_inbound_envelopes_to_recover');
      return;
    }

    const grouped = new Map<string, TrackedEnvelope[]>();
    for (const tracked of failedInbound) {
      const serviceName = tracked.serviceName ?? 'unknown';
      const list = grouped.get(serviceName) ?? [];
      list.push(tracked);
      grouped.set(serviceName, list);
    }

    await this.pendingRecoveryLock.runExclusive(async () => {
      this.pendingRecoveryServices.clear();
      for (const [serviceName, envelopes] of grouped.entries()) {
        this.pendingRecoveryServices.add(serviceName);
        this.pendingRecoveryEnvelopes.set(serviceName, envelopes);
      }
    });

    logger.debug('discovered_failed_inbound_envelopes', {
      total: failedInbound.length,
      services: Array.from(grouped.keys()),
    });
  }

  async listen(
    serviceName: string,
    handler?: FameEnvelopeHandler | null,
    options: ListenOptions = {}
  ): Promise<FameAddress> {
    const { capabilities = null, pollTimeoutMs = DEFAULT_POLLING_TIMEOUT_MS } = options;

    logger.debug('listen_start', {
      recipient: serviceName,
      poll_timeout_ms: pollTimeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS,
    });

    if (handler) {
      await this.serviceHandlersLock.runExclusive(async () => {
        this.serviceHandlers.set(serviceName, handler);
      });

      this.spawn(() => this.recoverServiceIfNeeded(serviceName), {
        name: `recover-on-listen-${serviceName}`,
      });
    }

    const stopState = { stopped: false };
    const binding = await this.bindingManager.bind(serviceName, capabilities ?? undefined);
    const channel = binding.channel;

    const trackingHandler: FameEnvelopeHandler = async (
      envelope,
      context
    ): Promise<FameMessageResponse | null | undefined> => {
      const tracked = await this.deliveryTracker.onEnvelopeDelivered(
        serviceName,
        envelope,
        context
      );

      if (
        handler &&
        (!tracked || tracked.status === EnvelopeStatus.RECEIVED || tracked.status === EnvelopeStatus.FAILED_TO_HANDLE)
      ) {
        const receiverPolicy = this.nodeLike.deliveryPolicy?.receiverRetryPolicy ?? null;
        if (tracked && tracked.attempt > 0) {
          logger.info('resuming_handler_retry_after_restart', {
            envelope_id: envelope.id,
            current_attempts: tracked.attempt,
            service_name: serviceName,
          });
        }

        return this.executeHandlerWithRetries(
          handler,
          envelope,
          context,
          receiverPolicy ?? undefined,
          tracked ?? undefined,
          serviceName
        );
      }

      return null;
    };

    const task = this.spawn(
      async () => {
        await this.channelPollingManager.startPollingLoop(
          serviceName,
          channel,
          trackingHandler,
          stopState,
          pollTimeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS
        );
      },
      { name: `listener-${serviceName}` }
    );

    const listener = new EnvelopeListener(() => {
      stopState.stopped = true;
    }, task);

    await this.listenersLock.runExclusive(async () => {
      const existing = this.listeners.get(serviceName);
      if (existing) {
        logger.debug('replacing_envelope_listener', { recipient: serviceName });
        existing.listener.stop();
        try {
          await existing.listener.task.promise;
        } catch {
          // Ignore cancellation errors
        }
      }
      this.listeners.set(serviceName, {
        handler: handler ?? null,
        listener,
        binding,
      });
    });

    return binding.address;
  }

  async listenRpc(
    serviceName: string,
    handler: FameRPCHandler,
    options: ListenOptions = {}
  ): Promise<FameAddress> {
    logger.debug('rpc_listen_start', { service_name: serviceName });

    const rpcHandler: FameEnvelopeHandler = async (envelope, context) => {
      const result = await this.rpcServerHandler.handleRpcRequest(
        envelope,
        context,
        handler,
        serviceName
      );
      return result ?? null;
    };

    const address = await this.listen(serviceName, rpcHandler, options);

    logger.debug('rpc_listen_bound', {
      service_name: serviceName,
      address: address.toString(),
    });

    return address;
  }

  async invoke(options: {
    targetAddr?: FameAddress;
    capabilities?: string[];
    method: string;
    params: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    const invokeOptions: Parameters<RPCClientManager['invoke']>[0] = {
      method: options.method,
      params: options.params,
      timeoutMs: options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS,
    };

    if (options.targetAddr) {
      invokeOptions.targetAddr = options.targetAddr;
    }

    if (options.capabilities) {
      invokeOptions.capabilities = options.capabilities;
    }

    return this.rpcClientManager.invoke(invokeOptions);
  }

  async invokeStream(options: {
    targetAddr?: FameAddress;
    capabilities?: string[];
    method: string;
    params: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<AsyncIterable<unknown>> {
    const streamOptions: Parameters<RPCClientManager['invokeStream']>[0] = {
      method: options.method,
      params: options.params,
      timeoutMs: options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS,
    };

    if (options.targetAddr) {
      streamOptions.targetAddr = options.targetAddr;
    }

    if (options.capabilities) {
      streamOptions.capabilities = options.capabilities;
    }

    return this.rpcClientManager.invokeStream(streamOptions);
  }

  async deliverToAddress(
    address: FameAddress | string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const entry = await this.listenersLock.runExclusive(async () => {
      for (const listener of this.listeners.values()) {
        if (listener.binding.address.toString() === address.toString()) {
          return listener;
        }
      }
      return null;
    });

    if (!entry || !entry.handler) {
      throw new Error(`No listener registered for address: ${address.toString()}`);
    }

    await entry.handler(envelope, context);
  }

  getHandler(serviceName: string): FameEnvelopeHandler | undefined {
    return this.serviceHandlers.get(serviceName);
  }

  private async recoverServiceIfNeeded(serviceName: string): Promise<void> {
    const lock = await this.getServiceRecoveryLock(serviceName);
    await lock.runExclusive(async () => {
      const handler = await this.serviceHandlersLock.runExclusive(async () =>
        this.serviceHandlers.get(serviceName)
      );

      if (!handler) {
        return;
      }

      const envelopes = await this.pendingRecoveryLock.runExclusive(async () => {
        const cached = this.pendingRecoveryEnvelopes.get(serviceName) ?? [];
        this.pendingRecoveryEnvelopes.delete(serviceName);
        this.pendingRecoveryServices.delete(serviceName);
        return cached;
      });

      if (!envelopes.length) {
        logger.debug('no_cached_recovery_for_service', { service_name: serviceName });
        return;
      }

      logger.debug('recovering_unhandled_envelopes_on_listen', {
        service_name: serviceName,
        count: envelopes.length,
        envelope_ids: envelopes.map((env) => env.envelopeId),
      });

      await this.recoverServiceEnvelopes(serviceName, envelopes, handler);
    });
  }

  private async recoverServiceEnvelopes(
    serviceName: string,
    envelopes: TrackedEnvelope[],
    handler: FameEnvelopeHandler
  ): Promise<void> {
    for (const tracked of envelopes) {
      try {
        logger.warning('recovering_unhandled_envelope', {
          envelope_id: tracked.envelopeId,
          service_name: serviceName,
          current_attempts: tracked.attempt,
          status: tracked.status,
        });

        const originalEnvelope = tracked.originalEnvelope;
        const receiverPolicy = this.nodeLike.deliveryPolicy?.receiverRetryPolicy ?? undefined;

        await this.executeHandlerWithRetries(
          handler,
          originalEnvelope,
          undefined,
          receiverPolicy,
          tracked,
          serviceName
        );

        logger.debug('envelope_recovery_completed', {
          envelope_id: tracked.envelopeId,
          service_name: serviceName,
        });
      } catch (error) {
        logger.error('envelope_recovery_failed', {
          envelope_id: tracked.envelopeId,
          service_name: serviceName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async executeHandlerWithRetries(
    handler: FameEnvelopeHandler,
    envelope: FameEnvelope,
    context: FameDeliveryContext | undefined,
    retryPolicy: RetryPolicy | undefined,
    trackedEnvelope: TrackedEnvelope | undefined,
    inboxName: string
  ): Promise<FameMessageResponse | null | undefined> {
    if (!retryPolicy || retryPolicy.maxRetries === 0) {
      try {
        const result = await handler(envelope, context);
        if (trackedEnvelope) {
          await this.deliveryTracker.onEnvelopeHandled(trackedEnvelope);
        }
        return result as FameMessageResponse | null | undefined;
      } catch (error) {
        if (trackedEnvelope) {
          trackedEnvelope.attempt += 1;
          await this.deliveryTracker.onEnvelopeHandleFailed(
            inboxName,
            trackedEnvelope,
            context,
            error instanceof Error ? error : new Error(String(error)),
            true
          );
        }
        throw error;
      }
    }

    const trackedAttempt = trackedEnvelope?.attempt ?? 0;
    const maxAttempts = (retryPolicy?.maxRetries ?? 0) + 1;

    if (trackedAttempt >= maxAttempts) {
      const error = new Error(
        `Handler retries exhausted: ${trackedAttempt}/${maxAttempts}`
      );
      if (trackedEnvelope) {
        await this.deliveryTracker.onEnvelopeHandleFailed(
          inboxName,
          trackedEnvelope,
          context,
          error,
          true
        );
      }
      throw error;
    }

    let currentAttempt = trackedAttempt;
    let lastError: unknown = null;

    while (currentAttempt < maxAttempts) {
      try {
        if (trackedEnvelope) {
          trackedEnvelope.attempt = currentAttempt + 1;
        }

        const result = await handler(envelope, context);

        if (trackedEnvelope) {
          await this.deliveryTracker.onEnvelopeHandled(trackedEnvelope);
        }

        if (currentAttempt > 0) {
          logger.info('handler_retry_succeeded', {
            envelope_id: envelope.id,
            attempt: currentAttempt + 1,
            total_attempts: currentAttempt + 1,
          });
        }

        return result as FameMessageResponse | null | undefined;
      } catch (error) {
        lastError = error;
        const attemptNumber = currentAttempt + 1;
        const isFinalAttempt = attemptNumber >= maxAttempts;

        if (trackedEnvelope) {
          await this.deliveryTracker.onEnvelopeHandleFailed(
            inboxName,
            trackedEnvelope,
            context,
            error instanceof Error ? error : new Error(String(error)),
            isFinalAttempt
          );
        }

        if (isFinalAttempt) {
          logger.error('handler_execution_failed_exhausted_retries', {
            envelope_id: envelope.id,
            total_attempts: attemptNumber,
            max_retries: retryPolicy?.maxRetries ?? 0,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }

        const delayMs = retryPolicy?.nextDelayMs(attemptNumber) ?? 0;
        logger.warning('handler_execution_failed_will_retry', {
          envelope_id: envelope.id,
          attempt: attemptNumber,
          max_retries: retryPolicy?.maxRetries ?? 0,
          delay_ms: delayMs,
          error: error instanceof Error ? error.message : String(error),
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        currentAttempt += 1;
      }
    }

    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    return undefined;
  }

  private async getServiceRecoveryLock(serviceName: string): Promise<AsyncMutex> {
    return this.serviceRecoveryLocksLock.runExclusive(async () => {
      let lock = this.serviceRecoveryLocks.get(serviceName);
      if (!lock) {
        lock = new AsyncMutex();
        this.serviceRecoveryLocks.set(serviceName, lock);
      }
      return lock;
    });
  }
}