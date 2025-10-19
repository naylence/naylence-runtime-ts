import {
  DeliveryAckFrame,
  DeliveryOriginType,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
  generateId,
} from 'naylence-core';

import { getLogger } from '../util/logging.js';
import { color, AnsiColor } from '../util/formatter.js';
import {
  formatTimestampForConsole,
  prettyModel,
  showEnvelopes,
} from '../util/util.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { AsyncLock } from '../util/lock.js';
import { TaskCancelledError, SpawnedTask } from '../util/task-types.js';
import type { RetryPolicy } from './retry-policy.js';
import type { RetryEventHandler } from './retry-event-handler.js';
import {
  EnvelopeStatus,
  MailboxType,
  TrackedEnvelope,
} from './tracked-envelope.js';
import { formatDeliveryErrorMessage } from './delivery-error.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { KeyValueStore } from '../storage/key-value-store.js';
import type { NodeLike } from '../node/node-like.js';
import type { NodeEventListener } from '../node/node-event-listener.js';

const logger = getLogger('naylence.fame.delivery.default_delivery_tracker');

const STREAM_END = Symbol('stream-end');
const SWEEPER_TICK = Symbol('tracker-sweeper-tick');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  enqueue(value: T): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(value);
    } else {
      this.items.push(value);
    }
  }

  dequeue(): Promise<T> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T);
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  drain(handler: (value: T) => void): void {
    while (this.items.length > 0) {
      handler(this.items.shift() as T);
    }
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(STREAM_END as unknown as T);
    }
  }
}

interface EnvelopeFuture<T> extends Deferred<T> {
  readonly expectedResponseType: FameResponseType;
  done: boolean;
}

function createEnvelopeFuture(
  expectedResponseType: FameResponseType
): EnvelopeFuture<FameEnvelope> {
  const deferred = createDeferred<FameEnvelope>();
  let done = false;
  const wrapResolve = (value: FameEnvelope | PromiseLike<FameEnvelope>) => {
    if (!done) {
      done = true;
      deferred.resolve(value);
    }
  };
  const wrapReject = (reason?: unknown) => {
    if (!done) {
      done = true;
      deferred.reject(reason);
    }
  };
  // Attach a noop rejection handler so that early rejections before consumers await the
  // promise are marked as handled. This mirrors the Python runtime behaviour where the
  // delivery tracker owns the lifecycle of the future.
  deferred.promise.catch(() => undefined);
  return {
    promise: deferred.promise,
    resolve: wrapResolve,
    reject: wrapReject,
    expectedResponseType,
    get done() {
      return done;
    },
    set done(value: boolean) {
      done = value;
    },
  };
}

export interface DeliveryTrackerEventHandler {
  onEnvelopeTimeout?(envelope: TrackedEnvelope): Promise<void> | void;
  onEnvelopeAcked?(envelope: TrackedEnvelope): Promise<void> | void;
  onEnvelopeNacked?(
    envelope: TrackedEnvelope,
    reason: string | null
  ): Promise<void> | void;
  onEnvelopeReplied?(
    envelope: TrackedEnvelope,
    replyEnvelope: FameEnvelope
  ): Promise<void> | void;
}

export interface TrackOptions {
  timeoutMs: number;
  expectedResponseType: FameResponseType;
  retryPolicy?: RetryPolicy | null;
  retryHandler?: RetryEventHandler | null;
  meta?: Record<string, unknown> | null;
}

export class DefaultDeliveryTracker
  extends TaskSpawner
  implements NodeEventListener
{
  public readonly priority: number;

  private readonly storageProvider: StorageProvider;
  private outbox: KeyValueStore<TrackedEnvelope> | null = null;
  private inbox: KeyValueStore<TrackedEnvelope> | null = null;
  private inboxDlq: KeyValueStore<TrackedEnvelope> | null = null;
  private node: NodeLike | null = null;

  private readonly correlationToEnvelope = new Map<string, string>();
  private readonly timers = new Map<string, SpawnedTask<void>>();
  private readonly ackFutures = new Map<string, EnvelopeFuture<FameEnvelope>>();
  private readonly replyFutures = new Map<
    string,
    EnvelopeFuture<FameEnvelope>
  >();
  private readonly ackDoneSince = new Map<string, number>();
  private readonly replyDoneSince = new Map<string, number>();
  private futuresSweeper: SpawnedTask<void> | null = null;

  private readonly streamQueues = new Map<string, AsyncQueue<unknown>>();
  private readonly streamDone = new Map<string, Deferred<void>>();

  private readonly lock = new AsyncLock();
  private shutdownSignal: Deferred<void> = createDeferred<void>();

  private readonly futGcGraceSecs: number;
  private readonly futSweepIntervalSecs: number;

  private readonly eventHandlers = new Set<DeliveryTrackerEventHandler>();

  constructor(
    storageProvider: StorageProvider,
    options: {
      futuresGcGraceSecs?: number;
      futuresSweepIntervalSecs?: number;
    } = {}
  ) {
    super();
    this.storageProvider = storageProvider;
    this.priority = 1000;
    this.futGcGraceSecs = Math.max(
      0,
      Math.trunc(options.futuresGcGraceSecs ?? 120)
    );
    this.futSweepIntervalSecs = Math.max(
      1,
      Math.trunc(options.futuresSweepIntervalSecs ?? 30)
    );
  }

  addEventHandler(handler: DeliveryTrackerEventHandler): void {
    this.eventHandlers.add(handler);
  }

  removeEventHandler(handler: DeliveryTrackerEventHandler): void {
    this.eventHandlers.delete(handler);
  }

  async onNodeInitialized(node: NodeLike): Promise<void> {
    this.node = node;
    this.outbox = await this.storageProvider.getKeyValueStore(
      TrackedEnvelope,
      '__delivery_outbox'
    );
    this.inbox = await this.storageProvider.getKeyValueStore(
      TrackedEnvelope,
      '__delivery_inbox'
    );
    this.inboxDlq = await this.storageProvider.getKeyValueStore(
      TrackedEnvelope,
      '__delivery_inbox_dlq'
    );
  }

  async onNodeStarted(node: NodeLike): Promise<void> {
    this.node = node;
    if (!this.futuresSweeper) {
      this.shutdownSignal = createDeferred<void>();
      this.futuresSweeper = this.spawn(
        (signal) => this.sweepFuturesLoop(signal),
        {
          name: 'tracker-futures-sweeper',
        }
      );
    }
    await this.recoverPending();
  }

  async onNodePreparingToStop(_node: NodeLike): Promise<void> {
    await this.waitForPendingAcks();
  }

  async onNodeStopped(_node: NodeLike): Promise<void> {
    await this.cleanup();
    await this.shutdownTasks();
  }

  async onForwardUpstreamComplete(
    node: NodeLike,
    envelope: FameEnvelope,
    result?: unknown,
    error?: Error,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    void node;
    void result;
    void error;
    void context;
    if (showEnvelopes) {
      console.log(
        `\n${formatTimestampForConsole()} - ${color('Forwarded envelope to upstream', AnsiColor.BLUE)} 🚀\n${prettyModel(envelope)}`
      );
    }
    return envelope;
  }

  async onForwardToRouteComplete(
    node: NodeLike,
    nextSegment: string,
    envelope: FameEnvelope,
    result?: unknown,
    error?: Error,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    void node;
    void result;
    void error;
    void context;
    if (showEnvelopes) {
      console.log(
        `\n${formatTimestampForConsole()} - ${color(
          `Forwarded envelope to route "${nextSegment}"`,
          AnsiColor.BLUE
        )} 🚀\n${prettyModel(envelope)}`
      );
    }
    return envelope;
  }

  async onForwardToPeerComplete(
    node: NodeLike,
    peerSegment: string,
    envelope: FameEnvelope,
    result?: unknown,
    error?: Error,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    void node;
    void result;
    void error;
    void context;
    if (showEnvelopes) {
      console.log(
        `\n${formatTimestampForConsole()} - ${color(
          `Forwarded envelope to peer "${peerSegment}"`,
          AnsiColor.BLUE
        )} 🚀\n${prettyModel(envelope)}`
      );
    }
    return envelope;
  }

  async onHeartbeatSent(node: NodeLike, envelope: FameEnvelope): Promise<void> {
    void node;
    if (showEnvelopes) {
      console.log(
        `\n${formatTimestampForConsole()} - ${color('Sent envelope', AnsiColor.BLUE)} 🚀\n${prettyModel(
          envelope
        )}`
      );
    }
  }

  async track(
    envelope: FameEnvelope,
    options: TrackOptions
  ): Promise<TrackedEnvelope | null> {
    const outbox = this.ensureOutbox();
    const nowMs = Date.now();
    const expectedResponseType = options.expectedResponseType;

    const tracked = await this.lock.runExclusive(async () => {
      if (this.ackFutures.has(envelope.id)) {
        logger.debug('tracker_envelope_already_tracked', {
          envp_id: envelope.id,
        });
        return null;
      }

      const corrId = envelope.corrId ?? (envelope.corrId = generateId());
      const existingEnvId = this.correlationToEnvelope.get(corrId);

      if (
        expectedResponseType & FameResponseType.REPLY ||
        expectedResponseType & FameResponseType.STREAM
      ) {
        if (existingEnvId && existingEnvId !== envelope.id) {
          logger.debug('envelope_already_tracked_for_replies', {
            envp_id: envelope.id,
            corr_id: corrId,
            expected_response_type: expectedResponseType,
          });
          return null;
        }
        this.correlationToEnvelope.set(corrId, envelope.id);
      }

      if (expectedResponseType & FameResponseType.ACK) {
        const future = createEnvelopeFuture(expectedResponseType);
        this.ackFutures.set(envelope.id, future);
      }

      if (expectedResponseType & FameResponseType.REPLY) {
        const future = createEnvelopeFuture(expectedResponseType);
        this.replyFutures.set(envelope.id, future);
      }

      if (expectedResponseType & FameResponseType.STREAM) {
        this.streamQueues.set(envelope.id, new AsyncQueue());
        this.streamDone.set(envelope.id, createDeferred<void>());
      }

      const overallTimeoutMs = options.timeoutMs;
      let firstCheckpointMs = overallTimeoutMs;
      if (options.retryPolicy && options.retryPolicy.maxRetries > 0) {
        let firstDelayMs = overallTimeoutMs;
        try {
          firstDelayMs = Math.max(
            0,
            Math.trunc(options.retryPolicy.nextDelayMs(1))
          );
        } catch (error) {
          firstDelayMs = 0;
        }
        firstCheckpointMs = Math.min(overallTimeoutMs, firstDelayMs);
      }

      const tracked = new TrackedEnvelope({
        timeoutAtMs: nowMs + firstCheckpointMs,
        overallTimeoutAtMs: nowMs + overallTimeoutMs,
        expectedResponseType,
        createdAtMs: nowMs,
        ...(options.meta ? { meta: options.meta } : {}),
        mailboxType: MailboxType.OUTBOX,
        originalEnvelope: envelope,
      });

      await outbox.set(envelope.id, tracked);
      return tracked;
    });

    if (!tracked) {
      return null;
    }

    await this.scheduleTimer(
      tracked,
      options.retryPolicy ?? null,
      options.retryHandler ?? null
    );

    logger.debug('tracker_registered_envelope', {
      envp_id: envelope.id,
      corr_id: tracked.originalEnvelope.corrId,
      expected_response: tracked.expectedResponseType,
      target: envelope.to ? String(envelope.to) : null,
      timeout_ms: options.timeoutMs,
    });

    return tracked;
  }

  async awaitAck(
    envelopeId: string,
    timeoutMs?: number
  ): Promise<FameEnvelope> {
    const future = this.lockedGetFuture(this.ackFutures, envelopeId);
    if (!future) {
      throw new Error(`No ack expected for envelope ${envelopeId}`);
    }
    return this.awaitEnvelopeFuture(
      envelopeId,
      FameResponseType.ACK,
      future,
      timeoutMs
    );
  }

  async awaitReply(
    envelopeId: string,
    timeoutMs?: number
  ): Promise<FameEnvelope> {
    const future = this.lockedGetFuture(this.replyFutures, envelopeId);
    if (!future) {
      throw new Error(`No reply expected for envelope ${envelopeId}`);
    }
    return this.awaitEnvelopeFuture(
      envelopeId,
      FameResponseType.REPLY | FameResponseType.STREAM,
      future,
      timeoutMs
    );
  }

  async onEnvelopeDelivered(
    inboxName: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<TrackedEnvelope | null> {
    logger.debug('envelope_delivered', {
      envp_id: envelope.id,
      corr_id: envelope.corrId,
      rtype: envelope.rtype ?? FameResponseType.NONE,
      frame_type: envelope.frame?.type ?? 'unknown',
    });

    if (!envelope.corrId) {
      logger.debug('envelope_delivered_no_corr_id', {
        envelope_id: envelope.id,
      });
      return null;
    }

    if (this.isDeliveryAckFrame(envelope.frame)) {
      if (!envelope.frame.refId) {
        logger.debug('envelope_delivered_no_ref_id', {
          envelope_id: envelope.id,
        });
        return null;
      }

      if (envelope.frame.ok) {
        await this.onAck(envelope, context);
      } else {
        await this.onNack(envelope, context);
      }
      return null;
    }

    return this.onCorrelatedMessage(inboxName, envelope, context);
  }

  private async onCorrelatedMessage(
    inboxName: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<TrackedEnvelope | null> {
    void context;
    if (!envelope.corrId) {
      throw new Error('Envelope must have a correlation ID');
    }

    const outbox = this.ensureOutbox();
    const trackedId = await this.lock.runExclusive(async () =>
      this.correlationToEnvelope.get(envelope.corrId!)
    );

    let tracked: TrackedEnvelope | null = null;

    if (trackedId) {
      const outboxEntry = await outbox.get(trackedId);
      if (outboxEntry && outboxEntry.originalEnvelope.id !== envelope.id) {
        tracked = await this.onReply(envelope, outboxEntry, context);
      }
    }

    if (!tracked) {
      const inbox = this.ensureInbox();
      tracked = (await inbox.get(envelope.id)) ?? null;

      if (tracked) {
        if (tracked.status !== EnvelopeStatus.HANDLED) {
          tracked.status = EnvelopeStatus.RECEIVED;
          await inbox.set(envelope.id, tracked);
        } else {
          logger.debug('tracker_duplicate_envelope_already_handled', {
            envp_id: envelope.id,
            status: tracked.status,
          });
        }
      } else {
        tracked = new TrackedEnvelope({
          timeoutAtMs: 0,
          overallTimeoutAtMs: 0,
          expectedResponseType: envelope.rtype ?? FameResponseType.NONE,
          createdAtMs: Date.now(),
          status: EnvelopeStatus.RECEIVED,
          mailboxType: MailboxType.INBOX,
          originalEnvelope: envelope,
          serviceName: inboxName,
        });
        await inbox.set(envelope.id, tracked);
      }
    }

    if (envelope.rtype && Boolean(envelope.rtype & FameResponseType.ACK)) {
      await this.sendAck(envelope);
    }

    return tracked;
  }

  async onEnvelopeHandled(envelope: TrackedEnvelope): Promise<void> {
    const inbox = this.ensureInbox();
    envelope.status = EnvelopeStatus.HANDLED;
    await inbox.delete(envelope.originalEnvelope.id);
  }

  async onEnvelopeHandleFailed(
    inboxName: string,
    envelope: TrackedEnvelope,
    context?: FameDeliveryContext,
    error?: Error,
    isFinalFailure: boolean = false
  ): Promise<void> {
    void context;
    const inbox = this.ensureInbox();

    if (error) {
      const attempt = envelope.attempt;
      envelope.meta[`failure_attempt_${attempt}_reason`] = error.message;
      envelope.meta[`failure_attempt_${attempt}_type`] = error.name;
      envelope.meta['last_failure_reason'] = error.message;
      envelope.meta['last_failure_type'] = error.name;
    }

    if (isFinalFailure) {
      envelope.status = EnvelopeStatus.FAILED_TO_HANDLE;
      logger.error('envelope_handle_failed_final', {
        inbox_name: inboxName,
        envp_id: envelope.originalEnvelope.id,
        error: error?.message ?? 'unknown',
        status: envelope.status,
        total_attempts: envelope.attempt,
      });
      await this.addToInboxDlq(envelope, error?.message ?? null);
      await inbox.delete(envelope.originalEnvelope.id);
      return;
    }

    logger.warning('envelope_handle_failed_retry', {
      inbox_name: inboxName,
      envp_id: envelope.originalEnvelope.id,
      error: error?.message ?? 'unknown',
      attempt: envelope.attempt,
    });
    await inbox.set(envelope.originalEnvelope.id, envelope);
  }

  async updateTrackedEnvelope(envelope: TrackedEnvelope): Promise<void> {
    if (envelope.mailboxType === MailboxType.INBOX) {
      const inbox = this.ensureInbox();
      await inbox.update(envelope.originalEnvelope.id, envelope);
      return;
    }
    if (envelope.mailboxType === MailboxType.OUTBOX) {
      throw new Error(
        `Updating tracked envelopes of mailbox type ${MailboxType.OUTBOX} is not supported`
      );
    }
    const inbox = this.ensureInbox();
    await inbox.update(envelope.originalEnvelope.id, envelope);
  }

  async onAck(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    void context;
    if (!this.isDeliveryAckFrame(envelope.frame)) {
      throw new Error('Ack must be from a DeliveryAckFrame');
    }
    if (!envelope.corrId) {
      throw new Error('Ack envelope must have a correlation ID');
    }
    if (!envelope.frame.refId) {
      throw new Error('Ack frame must include refId');
    }

    const outbox = this.ensureOutbox();
    const tracked = await outbox.get(envelope.frame.refId);
    if (!tracked) {
      logger.debug('tracker_ack_for_unknown_envelope', {
        envp_id: envelope.id,
        ref_id: envelope.frame.refId,
        corr_id: envelope.corrId,
      });
      return;
    }

    if (tracked.originalEnvelope.corrId !== envelope.corrId) {
      logger.debug('tracker_ack_corr_id_mismatch', {
        envp_id: envelope.id,
        expected_corr_id: tracked.originalEnvelope.corrId,
        actual_corr_id: envelope.corrId,
      });
      return;
    }

    if (tracked.originalEnvelope.id === envelope.id) {
      return;
    }

    if (!(tracked.expectedResponseType & FameResponseType.STREAM)) {
      tracked.status = EnvelopeStatus.ACKED;
    }
    await outbox.set(tracked.originalEnvelope.id, tracked);

    await this.lock.runExclusive(async () => {
      const future = this.ackFutures.get(tracked.originalEnvelope.id);
      if (future && future.resolve) {
        future.resolve(envelope);
      }
    });

    await this.markDoneSince(
      this.ackFutures,
      tracked.originalEnvelope.id,
      this.ackDoneSince
    );
    await this.clearTimer(tracked.originalEnvelope.id);

    for (const handler of this.eventHandlers) {
      await handler.onEnvelopeAcked?.(tracked);
    }

    logger.debug('tracker_envelope_acked', {
      envp_id: tracked.originalEnvelope.id,
    });
  }

  async onNack(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    void context;
    if (!this.isDeliveryAckFrame(envelope.frame)) {
      throw new Error('Nack must be from a DeliveryAckFrame');
    }
    if (!envelope.corrId) {
      throw new Error('Nack envelope must have a correlation ID');
    }
    if (!envelope.frame.refId) {
      throw new Error('Ack frame must include refId');
    }

    const outbox = this.ensureOutbox();
    const tracked = await outbox.get(envelope.frame.refId);
    if (!tracked) {
      logger.debug('tracker_nack_for_unknown_envelope', {
        envp_id: envelope.id,
      });
      return;
    }

    if (tracked.originalEnvelope.corrId !== envelope.corrId) {
      logger.debug('tracker_nack_corr_id_mismatch', {
        envp_id: envelope.id,
        expected_corr_id: tracked.originalEnvelope.corrId,
        actual_corr_id: envelope.corrId,
      });
      return;
    }

    const ackFrame = envelope.frame;

    tracked.status = EnvelopeStatus.NACKED;
    tracked.meta['nack_code'] = ackFrame.code;
    if (ackFrame.reason) {
      tracked.meta['nack_reason'] = ackFrame.reason;
    } else {
      delete tracked.meta['nack_reason'];
    }
    await outbox.set(tracked.originalEnvelope.id, tracked);

    await this.lock.runExclusive(async () => {
      const message = formatDeliveryErrorMessage(
        ackFrame.code,
        ackFrame.reason ?? undefined
      );
      const nackError = new Error(message);

      const ackFuture = this.ackFutures.get(tracked.originalEnvelope.id);
      if (ackFuture && ackFuture.reject) {
        ackFuture.reject(nackError);
      }

      const replyFuture = this.replyFutures.get(tracked.originalEnvelope.id);
      if (replyFuture && replyFuture.reject) {
        replyFuture.reject(nackError);
      }
    });

    await this.markDoneSince(
      this.ackFutures,
      tracked.originalEnvelope.id,
      this.ackDoneSince
    );
    await this.markDoneSince(
      this.replyFutures,
      tracked.originalEnvelope.id,
      this.replyDoneSince
    );

    const queue = this.streamQueues.get(tracked.originalEnvelope.id);
    if (queue) {
      queue.enqueue(envelope);
      queue.enqueue(STREAM_END);
      const done = this.streamDone.get(tracked.originalEnvelope.id);
      done?.resolve();
    }

    await this.clearTimer(tracked.originalEnvelope.id);

    for (const handler of this.eventHandlers) {
      await handler.onEnvelopeNacked?.(tracked, ackFrame.reason ?? null);
    }

    logger.debug('tracker_envelope_nacked', {
      envp_id: tracked.originalEnvelope.id,
      reason: ackFrame.reason,
    });
  }

  async onReply(
    envelope: FameEnvelope,
    trackedEnvelope: TrackedEnvelope,
    context?: FameDeliveryContext
  ): Promise<TrackedEnvelope> {
    void context;
    if (!this.node) {
      throw new Error('Node is required to process replies');
    }

    const node = this.node;
    const outbox = this.ensureOutbox();

    if (trackedEnvelope.expectedResponseType & FameResponseType.STREAM) {
      await this.onStreamItem(trackedEnvelope.originalEnvelope.id, envelope);
      return trackedEnvelope;
    }

    trackedEnvelope.status = EnvelopeStatus.RESPONDED;
    await outbox.set(trackedEnvelope.originalEnvelope.id, trackedEnvelope);

    await this.clearTimer(trackedEnvelope.originalEnvelope.id);

    await this.lock.runExclusive(async () => {
      const replyFuture = this.replyFutures.get(
        trackedEnvelope.originalEnvelope.id
      );
      if (replyFuture && replyFuture.resolve) {
        replyFuture.resolve(envelope);
      }
      const ackFuture = this.ackFutures.get(
        trackedEnvelope.originalEnvelope.id
      );
      if (ackFuture && ackFuture.resolve) {
        const ackEnvelope = node.envelopeFactory.createEnvelope({
          to: envelope.replyTo ?? undefined,
          frame: {
            type: 'DeliveryAck',
            ok: true,
            refId: trackedEnvelope.originalEnvelope.id,
            reason: 'Auto-ack for reply',
          } satisfies DeliveryAckFrame,
          corrId: envelope.corrId ?? undefined,
          traceId: envelope.traceId ?? undefined,
        });
        ackFuture.resolve(ackEnvelope);
      }
    });

    await this.markDoneSince(
      this.replyFutures,
      trackedEnvelope.originalEnvelope.id,
      this.replyDoneSince
    );
    await this.markDoneSince(
      this.ackFutures,
      trackedEnvelope.originalEnvelope.id,
      this.ackDoneSince
    );

    if (envelope.rtype && Boolean(envelope.rtype & FameResponseType.ACK)) {
      await this.sendAck(envelope);
    }

    for (const handler of this.eventHandlers) {
      await handler.onEnvelopeReplied?.(trackedEnvelope, envelope);
    }

    logger.debug('tracked_envelope_replied', {
      envp_id: trackedEnvelope.originalEnvelope.id,
      corr_id: envelope.corrId,
    });

    return trackedEnvelope;
  }

  async *iterStream(
    envelopeId: string,
    timeoutMs?: number
  ): AsyncIterable<unknown> {
    const queue = this.streamQueues.get(envelopeId);
    const done = this.streamDone.get(envelopeId);
    if (!queue || !done) {
      return;
    }

    const perGetTimeout = timeoutMs ?? null;
    while (true) {
      let item: unknown;
      if (perGetTimeout && perGetTimeout > 0) {
        item = await this.dequeueWithTimeout(queue, perGetTimeout);
      } else {
        item = await queue.dequeue();
      }
      if (item === STREAM_END) {
        break;
      }
      if (item instanceof Error) {
        throw item;
      }
      yield item;
    }
    await done.promise.catch(() => undefined);
  }

  async onStreamItem(
    envelopeId: string,
    responseEnvelope: FameEnvelope
  ): Promise<void> {
    const queue = this.streamQueues.get(envelopeId);
    if (!queue) {
      return;
    }
    queue.enqueue(responseEnvelope);
  }

  async onStreamEnd(envelopeId: string): Promise<void> {
    const outbox = this.ensureOutbox();
    const entry = await outbox.get(envelopeId);
    if (entry) {
      entry.status = EnvelopeStatus.RESPONDED;
      await outbox.set(envelopeId, entry);
    }
    const queue = this.streamQueues.get(envelopeId);
    if (queue) {
      queue.enqueue(STREAM_END);
    }
    const done = this.streamDone.get(envelopeId);
    if (done) {
      done.resolve();
    }
  }

  async getTrackedEnvelope(
    envelopeId: string
  ): Promise<TrackedEnvelope | undefined> {
    const outbox = this.ensureOutbox();
    return outbox.get(envelopeId);
  }

  async listPending(): Promise<TrackedEnvelope[]> {
    const outbox = this.ensureOutbox();
    const allEntries = await outbox.list();
    return Object.values(allEntries).filter(
      (entry) => entry.status === EnvelopeStatus.PENDING
    );
  }

  async listInbound(
    filter?: (envelope: TrackedEnvelope) => boolean
  ): Promise<TrackedEnvelope[]> {
    const inbox = this.inbox;
    if (!inbox) {
      return [];
    }
    const allEntries = await inbox.list();
    return Object.values(allEntries).filter((entry) =>
      filter ? filter(entry) : true
    );
  }

  async addToInboxDlq(
    trackedEnvelope: TrackedEnvelope,
    reason: string | null = null
  ): Promise<void> {
    const dlq = this.inboxDlq;
    if (!dlq) {
      logger.error('dlq_not_initialized', {
        envp_id: trackedEnvelope.originalEnvelope.id,
      });
      return;
    }

    trackedEnvelope.meta['dlq'] = true;
    if (reason) {
      trackedEnvelope.meta['dlq_reason'] = reason;
    }
    trackedEnvelope.meta['dead_lettered_at_ms'] = Date.now();
    await dlq.set(trackedEnvelope.originalEnvelope.id, trackedEnvelope);
    logger.warning('envelope_moved_to_dlq', {
      envp_id: trackedEnvelope.originalEnvelope.id,
      service_name: trackedEnvelope.serviceName,
    });
  }

  async getFromInboxDlq(
    envelopeId: string
  ): Promise<TrackedEnvelope | undefined> {
    const dlq = this.inboxDlq;
    if (!dlq) {
      return undefined;
    }
    return dlq.get(envelopeId);
  }

  async listInboxDlq(): Promise<TrackedEnvelope[]> {
    const dlq = this.inboxDlq;
    if (!dlq) {
      return [];
    }
    const items = await dlq.list();
    return Object.values(items);
  }

  async purgeInboxDlq(
    predicate?: (tracked: TrackedEnvelope) => boolean
  ): Promise<number> {
    const dlq = this.inboxDlq;
    if (!dlq) {
      return 0;
    }
    const items = await dlq.list();
    const toDelete = Object.entries(items).filter(([, value]) =>
      predicate ? predicate(value) : true
    );
    await Promise.all(toDelete.map(([key]) => dlq.delete(key)));
    if (toDelete.length) {
      logger.debug('dlq_purged', { count: toDelete.length });
    }
    return toDelete.length;
  }

  async cleanup(): Promise<void> {
    this.shutdownSignal.resolve();

    const timers = await this.lock.runExclusive(async () => {
      const values = Array.from(this.timers.values());
      this.timers.clear();

      for (const future of this.ackFutures.values()) {
        future.reject(new Error('Tracker cleaned up before ACK received'));
      }
      this.ackFutures.clear();
      this.ackDoneSince.clear();

      for (const future of this.replyFutures.values()) {
        future.reject(new Error('Tracker cleaned up before reply received'));
      }
      this.replyFutures.clear();
      this.replyDoneSince.clear();

      for (const queue of this.streamQueues.values()) {
        queue.enqueue(STREAM_END);
      }
      this.streamQueues.clear();

      for (const done of this.streamDone.values()) {
        done.resolve();
      }
      this.streamDone.clear();

      this.correlationToEnvelope.clear();
      return values;
    });

    for (const timer of timers) {
      timer.cancel();
      try {
        await timer.promise;
      } catch (error) {
        if (!(error instanceof TaskCancelledError)) {
          throw error;
        }
      }
    }

    if (this.futuresSweeper) {
      this.futuresSweeper.cancel();
      try {
        await this.futuresSweeper.promise;
      } catch (error) {
        if (!(error instanceof TaskCancelledError)) {
          throw error;
        }
      }
      this.futuresSweeper = null;
    }

    logger.debug('tracker_cleanup_completed');
  }

  async recoverPending(): Promise<void> {
    const pending = await this.listPending();
    logger.debug('tracker_recovering_pending', { count: pending.length });

    await this.lock.runExclusive(async () => {
      for (const tracked of pending) {
        if (tracked.expectedResponseType & FameResponseType.ACK) {
          const future = createEnvelopeFuture(tracked.expectedResponseType);
          this.ackFutures.set(tracked.originalEnvelope.id, future);
        }
        if (tracked.expectedResponseType & FameResponseType.REPLY) {
          if (tracked.originalEnvelope.corrId) {
            this.correlationToEnvelope.set(
              tracked.originalEnvelope.corrId,
              tracked.originalEnvelope.id
            );
          }
          const future = createEnvelopeFuture(tracked.expectedResponseType);
          this.replyFutures.set(tracked.originalEnvelope.id, future);
        }
        if (tracked.expectedResponseType & FameResponseType.STREAM) {
          if (tracked.originalEnvelope.corrId) {
            this.correlationToEnvelope.set(
              tracked.originalEnvelope.corrId,
              tracked.originalEnvelope.id
            );
          }
          this.streamQueues.set(tracked.originalEnvelope.id, new AsyncQueue());
          this.streamDone.set(
            tracked.originalEnvelope.id,
            createDeferred<void>()
          );
        }
      }
    });

    for (const tracked of pending) {
      await this.scheduleTimer(tracked, null, null);
    }

    logger.debug('tracker_recovery_completed', { count: pending.length });
  }

  private ensureOutbox(): KeyValueStore<TrackedEnvelope> {
    if (!this.outbox) {
      throw new Error('Outbox is not initialized');
    }
    return this.outbox;
  }

  private ensureInbox(): KeyValueStore<TrackedEnvelope> {
    if (!this.inbox) {
      throw new Error('Inbox is not initialized');
    }
    return this.inbox;
  }

  private async waitForPendingAcks(): Promise<void> {
    logger.debug('tracker_node_preparing_to_stop_waiting_for_pending_acks');
    const outbox = this.outbox;
    if (!outbox) {
      return;
    }

    const pending: Array<{
      envelopeId: string;
      future: EnvelopeFuture<FameEnvelope>;
    } | null> = [];
    await this.lock.runExclusive(async () => {
      for (const [envelopeId, future] of this.ackFutures.entries()) {
        if (future.promise && typeof future.promise.then === 'function') {
          const isDone = await Promise.race([
            future.promise.then(
              () => true,
              () => true
            ),
            Promise.resolve(false),
          ]);
          if (!isDone) {
            pending.push({ envelopeId, future });
          }
        }
      }
    });

    if (!pending.length) {
      logger.debug('tracker_no_pending_acks_to_wait_for');
      return;
    }

    logger.debug('tracker_waiting_for_pending_acks', { count: pending.length });

    for (const entry of pending) {
      if (!entry) {
        continue;
      }
      try {
        const tracked = await outbox.get(entry.envelopeId);
        if (!tracked) {
          continue;
        }
        const nowMs = Date.now();
        const remainingMs = Math.max(0, tracked.overallTimeoutAtMs - nowMs);
        if (remainingMs <= 0) {
          continue;
        }
        try {
          await this.awaitWithTimeout(entry.future.promise, remainingMs);
          logger.debug('tracker_received_ack', {
            envelope_id: entry.envelopeId,
          });
          await outbox.delete(entry.envelopeId);
        } catch (error) {
          if (error instanceof Error && error.name === 'TimeoutError') {
            logger.debug('tracker_ack_timeout_expired', {
              envelope_id: entry.envelopeId,
            });
          } else {
            logger.debug('tracker_ack_wait_error', {
              envelope_id: entry.envelopeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        logger.error('tracker_error_waiting_for_ack', {
          envelope_id: entry.envelopeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug('tracker_finished_waiting_for_pending_acks');
  }

  private async scheduleTimer(
    tracked: TrackedEnvelope,
    retryPolicy: RetryPolicy | null,
    retryHandler: RetryEventHandler | null
  ): Promise<void> {
    const outbox = this.ensureOutbox();
    const node = this.node;
    if (!node) {
      throw new Error('Node is required to schedule timers');
    }

    await this.lock.runExclusive(async () => {
      const existing = this.timers.get(tracked.originalEnvelope.id);
      if (existing) {
        existing.cancel();
      }

      const task = this.spawn(
        async (signal) => {
          try {
            const nowMs = Date.now();
            const nextRetryAtMs = tracked.timeoutAtMs;
            const overallTimeoutAtMs = tracked.overallTimeoutAtMs;
            const delayMs = Math.max(
              0,
              Math.min(nextRetryAtMs, overallTimeoutAtMs) - nowMs
            );
            if (delayMs > 0) {
              await this.delay(delayMs, signal);
            }

            if (signal?.aborted) {
              return;
            }

            const entry = await outbox.get(tracked.originalEnvelope.id);
            if (!entry || entry.status !== EnvelopeStatus.PENDING) {
              return;
            }

            const currentTracked = entry;
            const currentNowMs = Date.now();

            if (currentNowMs >= currentTracked.overallTimeoutAtMs) {
              currentTracked.status = EnvelopeStatus.TIMED_OUT;
              await outbox.set(tracked.originalEnvelope.id, currentTracked);

              await this.lock.runExclusive(async () => {
                const ackFuture = this.ackFutures.get(
                  tracked.originalEnvelope.id
                );
                if (ackFuture) {
                  ackFuture.reject(new Error('Timeout waiting for ACK'));
                }
                const replyFuture = this.replyFutures.get(
                  tracked.originalEnvelope.id
                );
                if (replyFuture) {
                  replyFuture.reject(new Error('Timeout waiting for reply'));
                }
              });

              await this.markDoneSince(
                this.ackFutures,
                tracked.originalEnvelope.id,
                this.ackDoneSince
              );
              await this.markDoneSince(
                this.replyFutures,
                tracked.originalEnvelope.id,
                this.replyDoneSince
              );

              for (const handler of this.eventHandlers) {
                await handler.onEnvelopeTimeout?.(currentTracked);
              }

              logger.debug('tracker_envelope_timed_out', {
                envp_id: tracked.originalEnvelope.id,
              });
              return;
            }

            if (
              retryPolicy &&
              currentTracked.attempt < retryPolicy.maxRetries
            ) {
              currentTracked.attempt += 1;
              const nextDelayMs = retryPolicy.nextDelayMs(
                currentTracked.attempt
              );
              const nextRetryTime = currentNowMs + nextDelayMs;

              if (nextRetryTime <= currentTracked.overallTimeoutAtMs) {
                currentTracked.timeoutAtMs = nextRetryTime;
              } else {
                currentTracked.timeoutAtMs = currentTracked.overallTimeoutAtMs;
              }

              if (retryHandler) {
                await retryHandler.onRetryNeeded(
                  currentTracked.originalEnvelope,
                  currentTracked.attempt,
                  nextDelayMs,
                  {
                    fromSystemId: node.id,
                    originType: DeliveryOriginType.LOCAL,
                    expectedResponseType: currentTracked.expectedResponseType,
                  }
                );
              }

              await this.scheduleTimer(
                currentTracked,
                retryPolicy,
                retryHandler
              );
              logger.debug('envelope_delivery_retry_scheduled', {
                envp_id: tracked.originalEnvelope.id,
                attempt: currentTracked.attempt,
                max_retries: retryPolicy.maxRetries,
                next_delay_ms: nextDelayMs,
              });
              return;
            }

            if (currentNowMs < currentTracked.overallTimeoutAtMs) {
              currentTracked.timeoutAtMs = currentTracked.overallTimeoutAtMs;
              await outbox.set(tracked.originalEnvelope.id, currentTracked);
              await this.scheduleTimer(
                currentTracked,
                retryPolicy,
                retryHandler
              );
              logger.debug(
                'envelope_retries_exhausted_waiting_until_overall_timeout',
                {
                  envp_id: tracked.originalEnvelope.id,
                  attempt: currentTracked.attempt,
                  overall_timeout_at_ms: currentTracked.overallTimeoutAtMs,
                }
              );
              return;
            }

            currentTracked.status = EnvelopeStatus.TIMED_OUT;
            await outbox.set(tracked.originalEnvelope.id, currentTracked);

            await this.lock.runExclusive(async () => {
              const ackFuture = this.ackFutures.get(
                tracked.originalEnvelope.id
              );
              ackFuture?.reject(new Error('Timeout waiting for ACK'));
              const replyFuture = this.replyFutures.get(
                tracked.originalEnvelope.id
              );
              replyFuture?.reject(new Error('Timeout waiting for reply'));
            });

            await this.markDoneSince(
              this.ackFutures,
              tracked.originalEnvelope.id,
              this.ackDoneSince
            );
            await this.markDoneSince(
              this.replyFutures,
              tracked.originalEnvelope.id,
              this.replyDoneSince
            );

            for (const handler of this.eventHandlers) {
              await handler.onEnvelopeTimeout?.(currentTracked);
            }

            logger.debug('tracker_envelope_timed_out', {
              envp_id: tracked.originalEnvelope.id,
            });
          } catch (error) {
            if (error instanceof TaskCancelledError) {
              return;
            }
            logger.error('tracker_timer_error', {
              envp_id: tracked.originalEnvelope.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        {
          name: `tracker-${tracked.originalEnvelope.id}`,
        }
      );

      this.timers.set(tracked.originalEnvelope.id, task);
    });
  }

  private async clearTimer(envelopeId: string): Promise<void> {
    const timer = await this.lock.runExclusive(async () =>
      this.timers.get(envelopeId)
    );
    if (!timer) {
      return;
    }
    timer.cancel();
    try {
      await timer.promise;
    } catch (error) {
      if (!(error instanceof TaskCancelledError)) {
        throw error;
      }
    }
    await this.lock.runExclusive(async () => {
      this.timers.delete(envelopeId);
    });
  }

  private lockedGetFuture(
    registry: Map<string, EnvelopeFuture<FameEnvelope>>,
    key: string
  ): EnvelopeFuture<FameEnvelope> | undefined {
    return registry.get(key) ?? undefined;
  }

  private isDeliveryAckFrame(frame: any): frame is DeliveryAckFrame {
    return Boolean(
      frame &&
        typeof frame === 'object' &&
        frame.type &&
        frame.type.endsWith('Ack')
    );
  }

  private async awaitEnvelopeFuture(
    envelopeId: string,
    responseType: FameResponseType,
    future: EnvelopeFuture<FameEnvelope>,
    timeoutMs?: number
  ): Promise<FameEnvelope> {
    const outbox = this.ensureOutbox();
    let timeoutSeconds: number | null = null;

    if (typeof timeoutMs === 'number') {
      timeoutSeconds = timeoutMs;
    } else {
      const tracked = await outbox.get(envelopeId);
      if (tracked) {
        const remainingMs = Math.max(
          0,
          tracked.overallTimeoutAtMs - Date.now()
        );
        timeoutSeconds = remainingMs;
      }
    }

    try {
      if (timeoutSeconds !== null) {
        return await this.awaitWithTimeout(future.promise, timeoutSeconds);
      }
      logger.debug('await_envelope_no_timeout_wait', {
        envelope_id: envelopeId,
      });
      return await future.promise;
    } catch (error) {
      if (error instanceof Error && error.name !== 'TimeoutError') {
        throw error;
      }

      logger.error('await_envelope_timeout_error', {
        envelope_id: envelopeId,
        timeout_ms: timeoutSeconds,
        future_done: false,
        future_cancelled: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Timeout waiting for response_type(${responseType}) for envelope ${envelopeId}`
      );
    }
  }

  private async markDoneSince(
    registry: Map<string, EnvelopeFuture<FameEnvelope>>,
    envId: string,
    doneSinceMap: Map<string, number>
  ): Promise<void> {
    await this.lock.runExclusive(async () => {
      const future = registry.get(envId);
      if (future && !doneSinceMap.has(envId)) {
        doneSinceMap.set(envId, Date.now() / 1000);
      }
    });
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new TaskCancelledError('delay-cancelled');
    }

    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(new TaskCancelledError('delay-cancelled'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort);
        if (signal.aborted) {
          onAbort();
        }
      }
    });
  }

  private async awaitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    if (timeoutMs <= 0) {
      return promise;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' })
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async dequeueWithTimeout(
    queue: AsyncQueue<unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('stream timeout waiting for next item')),
        timeoutMs
      );
    });

    try {
      const value = await Promise.race([queue.dequeue(), timeoutPromise]);
      return value;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /* istanbul ignore next -- async sweeper loop paths are not deterministic in unit tests */
  private async sweepFuturesLoop(signal?: AbortSignal): Promise<void> {
    const shutdownToken = 'shutdown' as const;
    const shutdownPromise = this.shutdownSignal.promise.then(
      () => shutdownToken
    );

    while (true) {
      const delayController = new AbortController();
      const externalAbortHandler = (): void => {
        if (!delayController.signal.aborted) {
          delayController.abort();
        }
      };

      try {
        if (signal) {
          if (signal.aborted) {
            throw new TaskCancelledError('sweeper-aborted');
          }
          signal.addEventListener('abort', externalAbortHandler);
        }

        const waitForTick: Promise<typeof SWEEPER_TICK | typeof shutdownToken> =
          (async () => {
            try {
              await this.delay(
                this.futSweepIntervalSecs * 1000,
                delayController.signal
              );
              return SWEEPER_TICK;
            } catch (error) {
              if (error instanceof TaskCancelledError) {
                return shutdownToken;
              }
              throw error;
            }
          })();

        const result = await Promise.race<symbol | typeof shutdownToken>([
          shutdownPromise,
          waitForTick,
        ]);

        if (result !== SWEEPER_TICK) {
          break;
        }

        if (!this.outbox) {
          continue;
        }

        const now = Date.now() / 1000;
        const ackCandidates: string[] = [];
        const replyCandidates: string[] = [];

        await this.lock.runExclusive(async () => {
          for (const [envId, since] of this.ackDoneSince.entries()) {
            if (now - since >= this.futGcGraceSecs) {
              ackCandidates.push(envId);
            }
          }
          for (const [envId, since] of this.replyDoneSince.entries()) {
            if (now - since >= this.futGcGraceSecs) {
              replyCandidates.push(envId);
            }
          }
        });

        const toRemoveAck: string[] = [];
        const toRemoveReply: string[] = [];

        for (const envId of ackCandidates) {
          const tracked = await this.outbox.get(envId);
          if (!tracked || this.statusIsTerminal(tracked.status)) {
            toRemoveAck.push(envId);
          }
        }

        for (const envId of replyCandidates) {
          const tracked = await this.outbox.get(envId);
          if (!tracked || this.statusIsTerminal(tracked.status)) {
            toRemoveReply.push(envId);
          }
        }

        if (toRemoveAck.length || toRemoveReply.length) {
          await this.lock.runExclusive(async () => {
            for (const envId of toRemoveAck) {
              this.ackFutures.delete(envId);
              this.ackDoneSince.delete(envId);
            }
            for (const envId of toRemoveReply) {
              this.replyFutures.delete(envId);
              this.replyDoneSince.delete(envId);
            }
          });

          logger.debug('tracker_swept_completed_futures', {
            ack_removed: toRemoveAck.length,
            reply_removed: toRemoveReply.length,
            grace_secs: this.futGcGraceSecs,
          });
        }
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          break;
        }
        if (error instanceof Error && error.name === 'TimeoutError') {
          continue;
        }
        logger.error('tracker_sweeper_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (signal) {
          signal.removeEventListener('abort', externalAbortHandler);
        }
        if (!delayController.signal.aborted) {
          delayController.abort();
        }
      }
    }
  }

  private statusIsTerminal(status: EnvelopeStatus): boolean {
    switch (status) {
      case EnvelopeStatus.ACKED:
      case EnvelopeStatus.RESPONDED:
      case EnvelopeStatus.TIMED_OUT:
      case EnvelopeStatus.NACKED:
        return true;
      default:
        return false;
    }
  }

  private async sendAck(envelope: FameEnvelope): Promise<void> {
    if (!this.node) {
      return;
    }
    const node = this.node;
    if (!envelope.replyTo) {
      logger.error('cannot_send_ack_no_reply_to', { envp_id: envelope.id });
      return;
    }
    if (!envelope.corrId) {
      logger.error('cannot_send_ack_no_corr_id', { envp_id: envelope.id });
      return;
    }

    logger.debug('tracker_sending_ack', {
      envp_id: envelope.id,
      ref_id: envelope.id,
      to: envelope.replyTo,
      corr_id: envelope.corrId,
    });

    const ackEnvelope = node.envelopeFactory.createEnvelope({
      to: envelope.replyTo,
      frame: {
        type: 'DeliveryAck',
        ok: true,
        refId: envelope.id,
      } satisfies DeliveryAckFrame,
      corrId: envelope.corrId,
      traceId: envelope.traceId ?? undefined,
    });

    await node.send(ackEnvelope);
  }
}
