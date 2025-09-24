import {
  createFameEnvelope,
  DeliveryAckFrame,
  FameAddress,
  FameEnvelope,
  FameResponseType,
  generateId,
} from 'naylence-core';
import { DefaultDeliveryTracker } from '../default-delivery-tracker.js';
import { InMemoryStorageProvider } from '../../storage/in-memory-storage.js';
import type { NodeLike } from '../../node/node-like.js';
import { EnvelopeStatus, MailboxType, TrackedEnvelope } from '../tracked-envelope.js';
import { RetryPolicy } from '../retry-policy.js';
import { TaskCancelledError } from '../../util/task-types.js';

describe('DefaultDeliveryTracker', () => {
  function createNodeStub(overrides: Partial<NodeLike> = {}): NodeLike {
    const storageProvider = new InMemoryStorageProvider();
    const defaultAddress = new FameAddress('service@/stub');

    return {
      id: 'node-1',
      sid: 'sid-1',
      physicalPath: '/node-1',
      acceptedLogicals: new Set<string>(),
      envelopeFactory: {
        createEnvelope: createFameEnvelope,
      },
      deliveryPolicy: null,
      defaultBindingPath: '/node-1',
      hasParent: false,
      securityManager: null,
      admissionClient: null,
      eventListeners: [],
      upstreamConnector: null,
      publicUrl: null,
      storageProvider,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      bind: jest.fn(async () => ({
        channel: {} as any,
        address: defaultAddress,
      })),
      unbind: jest.fn(async () => undefined),
      send: jest.fn(async () => null),
      listen: jest.fn(async () => defaultAddress),
      listenRpc: jest.fn(async () => defaultAddress),
      invoke: jest.fn(async () => null),
      invokeByCapability: jest.fn(async () => null),
      invokeStream: jest.fn(async function* () {
        return;
      }),
      invokeByCapabilityStream: jest.fn(async function* () {
        return;
      }),
      deliver: jest.fn(async () => undefined),
      deliverLocal: jest.fn(async () => undefined),
      forwardUpstream: jest.fn(async () => undefined),
      hasLocal: jest.fn(() => false),
      gatherSupportedCallbackGrants: jest.fn(() => []),
      dispatchEvent: jest.fn(async () => undefined),
      dispatchEnvelopeEvent: jest.fn(async () => null),
      ...overrides,
    } as unknown as NodeLike;
  }

  function createTracker(provider = new InMemoryStorageProvider()) {
    const tracker = new DefaultDeliveryTracker(provider, {
      futuresSweepIntervalSecs: 1,
      futuresGcGraceSecs: 1,
    });
    return { tracker, provider };
  }

  function createDataEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
    const frame = overrides.frame ?? ({ type: 'Data', payload: { message: 'hello' } } as FameEnvelope['frame']);
    const options: Record<string, unknown> = { frame };
    if (overrides.corrId !== undefined) {
      options.corrId = overrides.corrId;
    }
    if (overrides.to !== undefined) {
      options.to = overrides.to;
    }
    if (overrides.rtype !== undefined) {
      options.responseType = overrides.rtype;
    }

    const envelope = createFameEnvelope(options as any);
    return { ...envelope, ...overrides };
  }

  function createAckEnvelope(
    refId: string,
    corrId: string,
    overrides: Partial<DeliveryAckFrame> = {}
  ): FameEnvelope {
    return {
      ...createFameEnvelope({
        frame: {
          type: 'DeliveryAck',
          ok: overrides.ok ?? true,
          refId,
          reason: overrides.reason,
          code: overrides.code,
        },
        corrId,
        responseType: FameResponseType.ACK,
      }),
      rtype: FameResponseType.ACK,
    };
  }

  async function startTracker(tracker: DefaultDeliveryTracker) {
    const node = createNodeStub();
    await tracker.onNodeInitialized(node);
    await tracker.onNodeStarted(node);
    return node;
  }

  async function disposeTracker(tracker: DefaultDeliveryTracker) {
    await tracker.cleanup();
    await tracker.shutdownTasks();
  }

  it('initializes with default timing options when none provided', () => {
    const tracker = new DefaultDeliveryTracker(new InMemoryStorageProvider());
    const trackerAny = tracker as any;
    expect(trackerAny.futGcGraceSecs).toBe(120);
    expect(trackerAny.futSweepIntervalSecs).toBe(30);
  });

  it('clamps negative timing options to minimums', () => {
    const tracker = new DefaultDeliveryTracker(new InMemoryStorageProvider(), {
      futuresGcGraceSecs: -5,
      futuresSweepIntervalSecs: 0,
    });
    const trackerAny = tracker as any;
    expect(trackerAny.futGcGraceSecs).toBe(0);
    expect(trackerAny.futSweepIntervalSecs).toBe(1);
  });

  it('ignores attempts to track duplicate reply correlations', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const firstEnvelope = createDataEnvelope();
      await tracker.track(firstEnvelope, {
        expectedResponseType: FameResponseType.REPLY,
        timeoutMs: 500,
      });
      void tracker.awaitReply(firstEnvelope.id).catch(() => undefined);

      const duplicate = createDataEnvelope({
        id: generateId(),
        corrId: firstEnvelope.corrId,
      });

      const result = await tracker.track(duplicate, {
        expectedResponseType: FameResponseType.REPLY,
        timeoutMs: 500,
      });

      expect(result).toBeNull();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('resolves ack futures when acknowledgements arrive', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      const tracked = await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 500,
      });
      expect(tracked).not.toBeNull();

    const ackPromise = tracker.awaitAck(envelope.id);
      const ackEnvelope = createAckEnvelope(envelope.id, envelope.corrId!);

      await tracker.onEnvelopeDelivered('outbox', ackEnvelope);

      await expect(ackPromise).resolves.toMatchObject({
        id: ackEnvelope.id,
        frame: { ok: true, refId: envelope.id },
      });

      const stored = await tracker.getTrackedEnvelope(envelope.id);
      expect(stored?.status).toBe(EnvelopeStatus.ACKED);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('resolves reply futures and auto-acks when a reply arrives', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.REPLY,
        timeoutMs: 500,
      });

    const ackPromise = tracker.awaitAck(envelope.id);
      const replyPromise = tracker.awaitReply(envelope.id, 500);

      const replyEnvelope = createDataEnvelope({
        id: generateId(),
        corrId: envelope.corrId!,
        rtype: FameResponseType.REPLY,
      });

      await tracker.onEnvelopeDelivered('outbox', replyEnvelope);

      await expect(replyPromise).resolves.toMatchObject({ id: replyEnvelope.id });
      await expect(ackPromise).resolves.toMatchObject({
        frame: { type: 'DeliveryAck', ok: true, refId: envelope.id },
      });

      const stored = await tracker.getTrackedEnvelope(envelope.id);
      expect(stored?.status).toBe(EnvelopeStatus.RESPONDED);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('streams responses and completes when onStreamEnd is called', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.STREAM,
        timeoutMs: 500,
      });

      const iterator = (async () => {
        const items: FameEnvelope[] = [];
        for await (const item of tracker.iterStream(envelope.id, 500)) {
          items.push(item as FameEnvelope);
        }
        return items;
      })();

      const streamChunk = createDataEnvelope({
        id: generateId(),
        corrId: envelope.corrId!,
        rtype: FameResponseType.STREAM,
      });

      await tracker.onEnvelopeDelivered('outbox', streamChunk);
      await tracker.onStreamEnd(envelope.id);

      await expect(iterator).resolves.toEqual([streamChunk]);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('rejects ack futures and terminates streams when a nack arrives', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.STREAM,
        timeoutMs: 500,
      });

      const ackPromise = tracker.awaitAck(envelope.id, 500);
      const streamItems = (async () => {
        const items: FameEnvelope[] = [];
        for await (const item of tracker.iterStream(envelope.id, 500)) {
          items.push(item as FameEnvelope);
        }
        return items;
      })();

      const nackEnvelope = createAckEnvelope(envelope.id, envelope.corrId!, {
        ok: false,
        reason: 'stream-failed',
      });

      await tracker.onEnvelopeDelivered('outbox', nackEnvelope);

      await expect(ackPromise).rejects.toThrow('Envelope nacked: stream-failed');
      await expect(streamItems).resolves.toEqual([nackEnvelope]);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('sends failed envelopes to the DLQ and purges them', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const inbound = createDataEnvelope({
        id: generateId(),
        corrId: generateId(),
        rtype: FameResponseType.ACK,
      });

      const trackedInbound = await tracker.onEnvelopeDelivered('inbox-service', inbound);
      expect(trackedInbound).not.toBeNull();

      await tracker.onEnvelopeHandleFailed('inbox-service', trackedInbound!, undefined, new Error('boom'), true);

      const items = await tracker.listInboxDlq();
      expect(items).toHaveLength(1);
      expect(items[0].meta['dlq']).toBe(true);
      expect(items[0].meta['dlq_reason']).toBe('boom');

      const purged = await tracker.purgeInboxDlq();
      expect(purged).toBe(1);
      const afterPurge = await tracker.listInboxDlq();
      expect(afterPurge).toHaveLength(0);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('rejects pending futures during cleanup', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 500,
      });

      const trackerAny = tracker as any;
      const ackFuture = trackerAny.ackFutures.get(envelope.id);
      expect(ackFuture).toBeDefined();

      const cleanupPromise = tracker.cleanup();

      await expect(ackFuture?.promise).rejects.toThrow('Tracker cleaned up before ACK received');
      await cleanupPromise;
    } finally {
      await tracker.shutdownTasks();
      await node.stop();
    }
  });

  it('ignores duplicate ack resolutions and same envelope ack ids', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 100,
      });

      const ackPromise = tracker.awaitAck(envelope.id);
      const ackEnvelope = createAckEnvelope(envelope.id, envelope.corrId!);

      await tracker.onEnvelopeDelivered('outbox', ackEnvelope);
      await expect(ackPromise).resolves.toBeDefined();

      const dupAck = { ...ackEnvelope, id: envelope.id };
      await tracker.onEnvelopeDelivered('outbox', dupAck);
      const stored = await tracker.getTrackedEnvelope(envelope.id);
      expect(stored?.status).toBe(EnvelopeStatus.ACKED);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('ack on stream-enabled envelopes keeps status pending', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.STREAM,
        timeoutMs: 100,
      });

      const ackEnvelope = createAckEnvelope(envelope.id, envelope.corrId!);
      await tracker.onEnvelopeDelivered('outbox', ackEnvelope);

      const tracked = await tracker.getTrackedEnvelope(envelope.id);
      expect(tracked?.status).toBe(EnvelopeStatus.PENDING);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('records nack metadata even when reason missing', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 100,
      });
      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const nackEnvelope = createAckEnvelope(envelope.id, envelope.corrId!, { ok: false });
      await tracker.onEnvelopeDelivered('outbox', nackEnvelope);

      const tracked = await tracker.getTrackedEnvelope(envelope.id);
      expect(tracked?.status).toBe(EnvelopeStatus.NACKED);
      expect(tracked?.meta['nack_reason']).toBeUndefined();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('treats expired pending acks as immediate timeouts during shutdown wait', async () => {
    jest.useFakeTimers();
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 0,
      });
      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const waitPromise = tracker.onNodePreparingToStop(node);
      await waitPromise;

      const tracked = await tracker.getTrackedEnvelope(envelope.id);
      expect(tracked?.status).toBe(EnvelopeStatus.TIMED_OUT);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
      jest.useRealTimers();
    }
  });

  it('does not recreate futures sweeper when node start repeats', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const initialSweeper = (tracker as any).futuresSweeper;
      await tracker.onNodeStarted(node);
      expect((tracker as any).futuresSweeper).toBe(initialSweeper);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('returns null when tracking the same envelope twice', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });
      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const duplicate = await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });

      expect(duplicate).toBeNull();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('handles retry policy failures while preserving metadata', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      class ThrowingPolicy extends RetryPolicy {
        override nextDelayMs(): number {
          throw new Error('boom');
        }
      }

      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 40,
        retryPolicy: new ThrowingPolicy({ maxRetries: 1 }),
        meta: { attempt: 1 },
      });
      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const stored = await tracker.getTrackedEnvelope(envelope.id);
      expect(stored?.meta['attempt']).toBe(1);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('logs retry policy warnings for non-error reasons and preserves tracking', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const thrownValue = 'string-policy-failure';
      const policy = {
        maxRetries: 1,
        nextDelayMs: jest.fn(() => {
          throw thrownValue;
        }),
      } as unknown as RetryPolicy;

      const envelope = createDataEnvelope({
        to: new FameAddress('dest@/service'),
      });

      const tracked = await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 80,
        retryPolicy: policy,
      });

      expect(tracked).not.toBeNull();
      expect(policy.nextDelayMs).toHaveBeenCalledWith(1);

      void tracker.awaitAck(envelope.id).catch(() => undefined);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('throws when awaiting ack or reply that was never tracked', async () => {
    const { tracker } = createTracker();
    await expect(tracker.awaitAck('missing')).rejects.toThrow('No ack expected');
    await expect(tracker.awaitReply('missing')).rejects.toThrow('No reply expected');
  });

  it('gracefully handles list and dlq operations before initialization', async () => {
    const tracker = new DefaultDeliveryTracker(new InMemoryStorageProvider());
    const tracked = new TrackedEnvelope({
      timeoutAtMs: Date.now(),
      overallTimeoutAtMs: Date.now(),
      expectedResponseType: FameResponseType.NONE,
      createdAtMs: Date.now(),
      mailboxType: MailboxType.INBOX,
      originalEnvelope: createDataEnvelope(),
    });

    expect(await tracker.listInbound()).toEqual([]);
    expect(await tracker.listInboxDlq()).toEqual([]);
    expect(await tracker.purgeInboxDlq()).toBe(0);
    await tracker.addToInboxDlq(tracked, 'pre-init');
  });

  it('classifies terminal statuses correctly', () => {
    const { tracker } = createTracker();
    const trackerAny = tracker as any;
    expect(trackerAny.statusIsTerminal(EnvelopeStatus.ACKED)).toBe(true);
    expect(trackerAny.statusIsTerminal(EnvelopeStatus.RESPONDED)).toBe(true);
    expect(trackerAny.statusIsTerminal(EnvelopeStatus.NACKED)).toBe(true);
    expect(trackerAny.statusIsTerminal(EnvelopeStatus.TIMED_OUT)).toBe(true);
    expect(trackerAny.statusIsTerminal(EnvelopeStatus.PENDING)).toBe(false);
  });

  it('handles sendAck validation failures gracefully', async () => {
    const { tracker } = createTracker();
    const trackerAny = tracker as any;

    const envelope = createDataEnvelope();
    await expect(trackerAny.sendAck(envelope)).resolves.toBeUndefined();

    trackerAny.node = createNodeStub();
    await expect(trackerAny.sendAck({ ...envelope, replyTo: undefined })).resolves.toBeUndefined();

    await expect(trackerAny.sendAck({ ...envelope, replyTo: new FameAddress('dest@/svc'), corrId: undefined })).resolves.toBeUndefined();
  });

  it('delay and await helpers honour timeout and abort semantics', async () => {
    jest.useFakeTimers();
    const { tracker } = createTracker();
    const trackerAny = tracker as any;

    await trackerAny.delay(0);

    const abortController = new AbortController();
    const delayPromise = trackerAny.delay(100, abortController.signal);
    abortController.abort();
    await expect(delayPromise).rejects.toThrow(TaskCancelledError);

    const futurePromise = Promise.resolve('ok');
    await expect(trackerAny.awaitWithTimeout(futurePromise, 0)).resolves.toBe('ok');

    const slowPromise = new Promise(() => undefined);
    const timeoutPromise = trackerAny.awaitWithTimeout(slowPromise, 10);
    jest.advanceTimersByTime(20);
    await expect(timeoutPromise).rejects.toThrow('TimeoutError');

    const pendingQueue = {
      dequeue: jest.fn(() => new Promise(() => undefined)),
    };
    const dequeuePromise = trackerAny.dequeueWithTimeout(pendingQueue, 10);
    jest.advanceTimersByTime(20);
    await expect(dequeuePromise).rejects.toThrow('stream timeout waiting for next item');

    const successQueue = {
      dequeue: jest.fn(() => Promise.resolve('value')),
    };
    const successPromise = trackerAny.dequeueWithTimeout(successQueue, 20);
    await expect(successPromise).resolves.toBe('value');

    jest.useRealTimers();
  });

  it('sweeps completed futures after grace period', async () => {
    const provider = new InMemoryStorageProvider();
    const { tracker } = createTracker(provider);
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.REPLY,
        timeoutMs: 200,
      });

      const ackPromise = tracker.awaitAck(envelope.id);
      const replyPromise = tracker.awaitReply(envelope.id);

      const replyEnvelope = createDataEnvelope({
        id: generateId(),
        corrId: envelope.corrId!,
        rtype: FameResponseType.REPLY,
      });

      await tracker.onEnvelopeDelivered('outbox', replyEnvelope);
      await tracker.onEnvelopeDelivered('outbox', createAckEnvelope(envelope.id, envelope.corrId!));

      await ackPromise;
      await replyPromise;

      const trackerAny = tracker as any;
      trackerAny.futGcGraceSecs = 0;

      const delaySpy = jest.spyOn(trackerAny, 'delay').mockImplementation(async () => undefined);
      try {
        const sweepPromise = trackerAny.sweepFuturesLoop();
        await Promise.resolve();
        trackerAny.shutdownSignal.resolve();
        await sweepPromise;
      } finally {
        delaySpy.mockRestore();
      }

      expect(trackerAny.ackFutures.size).toBe(0);
      expect(trackerAny.replyFutures.size).toBe(0);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });
  it('rebuilds pending futures during recovery', async () => {
    jest.useFakeTimers();
    const provider = new InMemoryStorageProvider();
    const { tracker: firstTracker } = createTracker(provider);
    const node = await startTracker(firstTracker);

    try {
      const envelope = createDataEnvelope();
      await firstTracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 100,
      });
      void firstTracker.awaitAck(envelope.id).catch(() => undefined);

      const { tracker: recoveredTracker } = createTracker(provider);
      const recoveredNode = await startTracker(recoveredTracker);

      const ackPromise = recoveredTracker.awaitAck(envelope.id, 5);
      jest.advanceTimersByTime(10);
      await expect(ackPromise).rejects.toThrow('Timeout waiting for response_type');

      await disposeTracker(recoveredTracker);
      await recoveredNode.stop();
    } finally {
      await disposeTracker(firstTracker);
      await node.stop();
      jest.useRealTimers();
    }
  });

  it('does not attempt to send ack when correlation id is missing', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const inbound = createDataEnvelope();
      inbound.corrId = undefined;

      const result = await tracker.onEnvelopeDelivered('inbox-service', inbound);
      expect(result).toBeNull();
      expect(node.send).not.toHaveBeenCalled();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('ignores ack envelopes without ref id', async () => {
    jest.useFakeTimers();
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });

      const ackPromise = tracker.awaitAck(envelope.id, 5);
      const malformedAck = createFameEnvelope({
        frame: {
          type: 'DeliveryAck',
          ok: true,
        } satisfies DeliveryAckFrame,
        corrId: envelope.corrId!,
        responseType: FameResponseType.ACK,
      });

      await tracker.onEnvelopeDelivered('outbox', malformedAck);

      jest.advanceTimersByTime(10);
      await expect(ackPromise).rejects.toThrow('Timeout waiting for response_type');
    } finally {
      await disposeTracker(tracker);
      await node.stop();
      jest.useRealTimers();
    }
  });

  it('ignores ack envelopes with mismatched correlation id', async () => {
    jest.useFakeTimers();
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });

      const ackPromise = tracker.awaitAck(envelope.id, 5);
      const mismatchedAck = createAckEnvelope(envelope.id, generateId());

      await tracker.onEnvelopeDelivered('outbox', mismatchedAck);

      jest.advanceTimersByTime(10);
      await expect(ackPromise).rejects.toThrow('Timeout waiting for response_type');
    } finally {
      await disposeTracker(tracker);
      await node.stop();
      jest.useRealTimers();
    }
  });

  it('sends ack for inbound envelopes requesting acknowledgements', async () => {
    const sendMock = jest.fn(async () => undefined);
    const node = createNodeStub({ send: sendMock as unknown as NodeLike['send'] });
    const { tracker } = createTracker();
    await tracker.onNodeInitialized(node);
    await tracker.onNodeStarted(node);

    try {
      const inbound = createDataEnvelope({
        corrId: generateId(),
        rtype: FameResponseType.ACK,
        replyTo: new FameAddress('other@/node'),
      });

      await tracker.onEnvelopeDelivered('inbox-service', inbound);

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          frame: expect.objectContaining({
            type: 'DeliveryAck',
            ok: true,
            refId: inbound.id,
          }),
        })
      );
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('waits for pending acknowledgements when stopping a node', async () => {
    jest.useFakeTimers();
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 40,
      });

      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const waitPromise = tracker.onNodePreparingToStop(node);
      jest.advanceTimersByTime(50);
      await waitPromise;

      const stored = await tracker.getTrackedEnvelope(envelope.id);
      expect(stored?.status).toBe(EnvelopeStatus.TIMED_OUT);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
      jest.useRealTimers();
    }
  });

  it('schedules retries and transitions to timeout when overall deadline passes', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const envelope = createDataEnvelope();
      const retryHandler = {
        onRetryNeeded: jest.fn(async () => undefined),
      };
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 40,
        retryPolicy: new RetryPolicy({
          maxRetries: 1,
          baseDelayMs: 5,
          maxDelayMs: 5,
          jitterMs: 0,
          backoffFactor: 1,
        }),
        retryHandler,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(retryHandler.onRetryNeeded).toHaveBeenCalledTimes(1);

      const trackerAny = tracker as any;
      const ackFuture = trackerAny.ackFutures.get(envelope.id);
      expect(ackFuture).toBeDefined();

      const ackResult = ackFuture.promise.catch((error: Error) => error.message);

      await new Promise((resolve) => setTimeout(resolve, 60));
      await expect(ackResult).resolves.toBe('Timeout waiting for ACK');

      expect(ackFuture.done).toBe(true);

      const tracked = await tracker.getTrackedEnvelope(envelope.id);
      expect(tracked?.status).toBe(EnvelopeStatus.TIMED_OUT);

      await tracker.onNodePreparingToStop(node);
      trackerAny.ackFutures.delete(envelope.id);
      trackerAny.ackDoneSince.delete(envelope.id);
      expect(trackerAny.ackFutures.size).toBe(0);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('rejects updates to outbox tracked envelopes', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });

      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const tracked = (await tracker.getTrackedEnvelope(envelope.id)) as TrackedEnvelope;
      expect(tracked.mailboxType).toBe(MailboxType.OUTBOX);

      await expect(tracker.updateTrackedEnvelope(tracked)).rejects.toThrow(
        'Updating tracked envelopes'
      );
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('validates ack envelopes before processing', async () => {
    const { tracker } = createTracker();
    const node = createNodeStub();
    await tracker.onNodeInitialized(node);

    const malformed = createDataEnvelope();
    await expect(tracker.onAck(malformed)).rejects.toThrow('Ack must be from a DeliveryAckFrame');

    const ackWithoutCorr = createAckEnvelope(malformed.id, generateId());
    (ackWithoutCorr as any).corrId = undefined;
    await expect(tracker.onAck(ackWithoutCorr)).rejects.toThrow('Ack envelope must have a correlation ID');

    const ackWithoutRef = createAckEnvelope(malformed.id, generateId());
    (ackWithoutRef.frame as DeliveryAckFrame).refId = undefined as any;
    await expect(tracker.onAck(ackWithoutRef)).rejects.toThrow('Ack frame must include refId');
  });

  it('ignores ack for envelopes that are no longer tracked', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const ack = createAckEnvelope(generateId(), generateId());
      await expect(tracker.onAck(ack)).resolves.toBeUndefined();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('validates nack envelopes before processing', async () => {
    const { tracker } = createTracker();
    const node = createNodeStub();
    await tracker.onNodeInitialized(node);

    const malformed = createDataEnvelope();
    await expect(tracker.onNack(malformed)).rejects.toThrow('Nack must be from a DeliveryAckFrame');

    const nackWithoutCorr = createAckEnvelope(generateId(), generateId(), { ok: false });
    (nackWithoutCorr as any).corrId = undefined;
    await expect(tracker.onNack(nackWithoutCorr)).rejects.toThrow('Nack envelope must have a correlation ID');

    const nackWithoutRef = createAckEnvelope(generateId(), generateId(), { ok: false });
    (nackWithoutRef.frame as DeliveryAckFrame).refId = undefined as any;
    await expect(tracker.onNack(nackWithoutRef)).rejects.toThrow('Ack frame must include refId');
  });

  it('handles nack correlation mismatches and stream queues', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.STREAM,
        timeoutMs: 200,
      });

      const ackPromise = tracker.awaitAck(envelope.id).catch((error: Error) => error.message);

      const mismatched = createAckEnvelope(envelope.id, generateId(), { ok: false });
      await tracker.onNack(mismatched);

      const queue = (tracker as any).streamQueues.get(envelope.id);
      expect(queue).toBeDefined();

      const validNack = createAckEnvelope(envelope.id, envelope.corrId!, { ok: false, reason: 'fail' });
      await tracker.onNack(validNack);

      await expect(ackPromise).resolves.toContain('Envelope nacked');

      const first = await queue.dequeue();
      expect(first).toMatchObject({ frame: expect.objectContaining({ type: 'DeliveryAck', ok: false }) });
      const second = await queue.dequeue();
      expect(typeof second).toBe('symbol');

      const done = (tracker as any).streamDone.get(envelope.id);
      await expect(done.promise).resolves.toBeUndefined();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('reuses existing inbound records without overwriting handled status', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const inbound = createDataEnvelope({ corrId: generateId(), rtype: FameResponseType.NONE });
      await tracker.onEnvelopeDelivered('service', inbound);

      const inbox = (tracker as any).inbox;
      const tracked = await inbox.get(inbound.id);
      tracked.status = EnvelopeStatus.HANDLED;
      await inbox.set(inbound.id, tracked);

      const second = await tracker.onEnvelopeDelivered('service', inbound);
      expect(second?.status).toBe(EnvelopeStatus.HANDLED);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('supports dlq operations when stores are initialized', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const inbound = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        mailboxType: MailboxType.INBOX,
        status: EnvelopeStatus.RECEIVED,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        serviceName: 'svc',
      });

      await tracker.addToInboxDlq(inbound, 'failure');
      const stored = await tracker.getFromInboxDlq(inbound.originalEnvelope.id);
      expect(stored?.meta['dlq']).toBe(true);
      expect(stored?.meta['dlq_reason']).toBe('failure');

      const purged = await tracker.purgeInboxDlq();
      expect(purged).toBe(1);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('iterates stream queues with timeouts and propagates errors', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const empty: unknown[] = [];
      for await (const item of tracker.iterStream('missing-id', 5)) {
        empty.push(item);
      }
      expect(empty).toHaveLength(0);

      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.STREAM,
        timeoutMs: 200,
      });

      await tracker.onStreamItem('unknown-id', createDataEnvelope());
      await tracker.onStreamEnd('unknown-id');

      const received: FameEnvelope[] = [];
      let caught: Error | null = null;
      const reader = (async () => {
        try {
          for await (const chunk of tracker.iterStream(envelope.id, 10)) {
            received.push(chunk as FameEnvelope);
          }
        } catch (error) {
          caught = error as Error;
        }
      })();

      const response = createDataEnvelope({ id: generateId(), corrId: envelope.corrId });
      await tracker.onStreamItem(envelope.id, response);
      await tracker.onStreamItem(envelope.id, new Error('stream failure') as unknown as FameEnvelope);
      await tracker.onStreamEnd(envelope.id);

      await reader;

      expect(received).toEqual([response]);
      expect((caught as Error | null)?.message).toBe('stream failure');
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('requires a node when processing replies', async () => {
    const { tracker } = createTracker();
    const tracked = new TrackedEnvelope({
      timeoutAtMs: Date.now(),
      overallTimeoutAtMs: Date.now(),
      expectedResponseType: FameResponseType.REPLY,
      createdAtMs: Date.now(),
      mailboxType: MailboxType.OUTBOX,
      status: EnvelopeStatus.PENDING,
      originalEnvelope: createDataEnvelope(),
    });

    await expect(tracker.onReply(createDataEnvelope(), tracked)).rejects.toThrow(
      'Node is required to process replies'
    );
  });

  it('records failure metadata and moves envelopes to the inbox DLQ on final failure', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const tracked = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        status: EnvelopeStatus.RECEIVED,
        mailboxType: MailboxType.INBOX,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        serviceName: 'svc',
        meta: {},
      });

      const inbox = (tracker as any).inbox;
      await inbox.set(tracked.originalEnvelope.id, tracked);

      const error = new Error('boom');
      await tracker.onEnvelopeHandleFailed('svc', tracked, undefined, error, false);
      const afterRetry = await inbox.get(tracked.originalEnvelope.id);
      expect(afterRetry?.meta['last_failure_reason']).toBe('boom');
      expect(afterRetry?.status).toBe(EnvelopeStatus.RECEIVED);

      await tracker.onEnvelopeHandleFailed('svc', tracked, undefined, error, true);
      const dlqEntry = await tracker.getFromInboxDlq(tracked.originalEnvelope.id);
      expect(dlqEntry?.status).toBe(EnvelopeStatus.FAILED_TO_HANDLE);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('moves envelopes to DLQ with unknown reason when failures lack messages', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const tracked = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        status: EnvelopeStatus.RECEIVED,
        mailboxType: MailboxType.INBOX,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        serviceName: 'svc',
        meta: {},
      });

      const inbox = (tracker as any).inbox;
      await inbox.set(tracked.originalEnvelope.id, tracked);

      await tracker.onEnvelopeHandleFailed('svc', tracked, undefined, null as unknown as Error, true);

      const dlqEntry = await tracker.getFromInboxDlq(tracked.originalEnvelope.id);
      expect(dlqEntry?.status).toBe(EnvelopeStatus.FAILED_TO_HANDLE);
      expect(dlqEntry?.meta['dlq']).toBe(true);
      expect(dlqEntry?.meta['dlq_reason']).toBeUndefined();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('updates inbound tracked envelopes in place', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const tracked = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        status: EnvelopeStatus.RECEIVED,
        mailboxType: MailboxType.INBOX,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        meta: {},
      });

      const inbox = (tracker as any).inbox;
      await inbox.set(tracked.originalEnvelope.id, tracked);

      tracked.meta['updated'] = true;
      await tracker.updateTrackedEnvelope(tracked);

      const stored = await inbox.get(tracked.originalEnvelope.id);
      expect(stored?.meta['updated']).toBe(true);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('ignores nack frames for envelopes that are no longer tracked', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    try {
      const nack = createAckEnvelope(generateId(), generateId(), { ok: false });
      await expect(tracker.onNack(nack)).resolves.toBeUndefined();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('waits for pending acknowledgements across missing entries and timeout errors', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const trackerAny = tracker as any;
      const outbox = trackerAny.outbox;

      const staleEnvelope = createDataEnvelope();
      await tracker.track(staleEnvelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 100,
      });
      const staleFuture = trackerAny.ackFutures.get(staleEnvelope.id) as any;
      staleFuture.promise = new Promise(() => undefined);
      const staleTracked = await outbox.get(staleEnvelope.id);
      staleTracked.overallTimeoutAtMs = Date.now() - 10;
      await outbox.set(staleEnvelope.id, staleTracked);

      const missingEnvelope = createDataEnvelope();
      await tracker.track(missingEnvelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 100,
      });
      const missingFuture = trackerAny.ackFutures.get(missingEnvelope.id) as any;
      missingFuture.promise = new Promise(() => undefined);
      await outbox.delete(missingEnvelope.id);

      const timeoutEnvelope = createDataEnvelope();
      await tracker.track(timeoutEnvelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 100,
      });
      const timeoutFuture = trackerAny.ackFutures.get(timeoutEnvelope.id) as any;
      timeoutFuture.promise = new Promise(() => undefined);
      const timeoutTracked = await outbox.get(timeoutEnvelope.id);
      timeoutTracked.overallTimeoutAtMs = Date.now() + 50;
      await outbox.set(timeoutEnvelope.id, timeoutTracked);

      const timeoutSpy = jest
        .spyOn(trackerAny, 'awaitWithTimeout')
        .mockImplementation(async () => {
          throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' });
        });

      await trackerAny.waitForPendingAcks();

      timeoutSpy.mockRestore();
      trackerAny.ackFutures.clear();
      trackerAny.ackDoneSince.clear();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('rejects outstanding futures when timers reach the overall timeout', async () => {
    jest.useFakeTimers();
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.REPLY,
        timeoutMs: 40,
      });

      const ackPromise = tracker.awaitAck(envelope.id).catch((error: Error) => error.message);
      const replyPromise = tracker.awaitReply(envelope.id).catch((error: Error) => error.message);

      const trackerAny = tracker as any;
      const outbox = trackerAny.outbox;
      const tracked = await outbox.get(envelope.id);
      tracked.timeoutAtMs = Date.now();
      tracked.overallTimeoutAtMs = Date.now() + 10;
      await outbox.set(envelope.id, tracked);

      await trackerAny.scheduleTimer(tracked, null, null);
      jest.advanceTimersByTime(20);

      await expect(ackPromise).resolves.toBe('Timeout waiting for ACK');
      await expect(replyPromise).resolves.toBe('Timeout waiting for reply');
    } finally {
      jest.useRealTimers();
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('handles timer errors when delay fails unexpectedly', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);
    const trackerAny = tracker as any;
    const delayMock = jest
      .spyOn(trackerAny, 'delay')
      .mockImplementation(async () => {
        throw new Error('forced delay failure');
      });

    try {
      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });
      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const task = trackerAny.timers.get(envelope.id);
      await expect(task.promise).resolves.toBeUndefined();
      expect(delayMock).toHaveBeenCalled();
    } finally {
      delayMock.mockRestore();
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('handles delivery failures without explicit error details', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const tracked = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        status: EnvelopeStatus.RECEIVED,
        mailboxType: MailboxType.INBOX,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        serviceName: 'svc',
        meta: {},
      });

      const inbox = (tracker as any).inbox;
      await inbox.set(tracked.originalEnvelope.id, tracked);

      await tracker.onEnvelopeHandleFailed('svc', tracked, undefined, undefined, false);
      const stored = await inbox.get(tracked.originalEnvelope.id);
      expect(stored?.meta['last_failure_reason']).toBeUndefined();
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('rebuilds reply and stream futures during recovery', async () => {
    const provider = new InMemoryStorageProvider();
    const envelope = createDataEnvelope();
    const tracked = new TrackedEnvelope({
      timeoutAtMs: Date.now() + 1_000,
      overallTimeoutAtMs: Date.now() + 5_000,
      expectedResponseType: FameResponseType.ACK | FameResponseType.REPLY | FameResponseType.STREAM,
      createdAtMs: Date.now(),
      status: EnvelopeStatus.PENDING,
      mailboxType: MailboxType.OUTBOX,
      originalEnvelope: envelope,
      meta: {},
    });

    const outbox = await provider.getKeyValueStore(TrackedEnvelope, '__delivery_outbox');
    await outbox.set(envelope.id, tracked);

    const { tracker: recovered } = createTracker(provider);
    const node = await startTracker(recovered);

    const trackerAny = recovered as any;
    expect(trackerAny.ackFutures.has(envelope.id)).toBe(true);
    expect(trackerAny.replyFutures.has(envelope.id)).toBe(true);
    expect(trackerAny.streamQueues.has(envelope.id)).toBe(true);

    void recovered.awaitAck(envelope.id).catch(() => undefined);
    void recovered.awaitReply(envelope.id).catch(() => undefined);

    await disposeTracker(recovered);
    await node.stop();
  });

  it('throws when accessing delivery stores before initialization', () => {
    const tracker = new DefaultDeliveryTracker(new InMemoryStorageProvider());
    const trackerAny = tracker as any;
    expect(() => trackerAny.ensureOutbox()).toThrow('Outbox is not initialized');
    expect(() => trackerAny.ensureInbox()).toThrow('Inbox is not initialized');
  });

  it('applies predicates when listing inbound envelopes', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const inbound = createDataEnvelope();
      await tracker.onEnvelopeDelivered('svc', inbound);

      const handled = await tracker.listInbound((entry) => entry.status === EnvelopeStatus.HANDLED);
      expect(handled).toHaveLength(0);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('purges dlq entries using predicates', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const first = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        status: EnvelopeStatus.RECEIVED,
        mailboxType: MailboxType.INBOX,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        serviceName: 'svc1',
        meta: {},
      });
      const second = new TrackedEnvelope({
        timeoutAtMs: Date.now(),
        overallTimeoutAtMs: Date.now(),
        expectedResponseType: FameResponseType.NONE,
        createdAtMs: Date.now(),
        status: EnvelopeStatus.RECEIVED,
        mailboxType: MailboxType.INBOX,
        originalEnvelope: createDataEnvelope({ id: generateId() }),
        serviceName: 'svc2',
        meta: { keep: true },
      });

      await tracker.addToInboxDlq(first, 'purge-me');
      await tracker.addToInboxDlq(second, 'keep-me');

      const removed = await tracker.purgeInboxDlq((entry) => entry.meta['keep'] !== true);
      expect(removed).toBe(1);
      const remaining = await tracker.listInboxDlq();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].meta['keep']).toBe(true);
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('invokes nack event handlers when envelopes are rejected', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const handler = { onEnvelopeNacked: jest.fn() };
      tracker.addEventHandler(handler);

      const envelope = createDataEnvelope();
      await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK,
        timeoutMs: 50,
      });
      void tracker.awaitAck(envelope.id).catch(() => undefined);

      const nack = createAckEnvelope(envelope.id, envelope.corrId!, { ok: false, reason: 'fail' });
      await tracker.onEnvelopeDelivered('outbox', nack);

      expect(handler.onEnvelopeNacked).toHaveBeenCalledWith(expect.any(TrackedEnvelope), 'fail');
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('resolves ack and reply futures when onReply is invoked directly', async () => {
    const { tracker } = createTracker();
    const node = await startTracker(tracker);

    try {
      const envelope = createDataEnvelope();
      const tracked = await tracker.track(envelope, {
        expectedResponseType: FameResponseType.ACK | FameResponseType.REPLY,
        timeoutMs: 200,
      });
      expect(tracked).not.toBeNull();

      const ackPromise = tracker.awaitAck(envelope.id);
      const replyPromise = tracker.awaitReply(envelope.id);

      const reply = createDataEnvelope({
        id: generateId(),
        corrId: envelope.corrId!,
        rtype: FameResponseType.REPLY,
      });

      await tracker.onReply(reply, tracked!, undefined);

      await expect(replyPromise).resolves.toMatchObject({ id: reply.id });
      await expect(ackPromise).resolves.toMatchObject({ frame: expect.objectContaining({ refId: envelope.id }) });
    } finally {
      await disposeTracker(tracker);
      await node.stop();
    }
  });

  it('aborts delays immediately when the signal is already cancelled', async () => {
    const { tracker } = createTracker();
    const trackerAny = tracker as any;
    const controller = new AbortController();
    controller.abort();
    await expect(trackerAny.delay(100, controller.signal)).rejects.toThrow(TaskCancelledError);
  });
});
