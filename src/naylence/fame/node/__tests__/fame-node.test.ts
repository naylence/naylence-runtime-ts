import { DeliveryOriginType, FameResponseType, formatAddress } from 'naylence-core';
import { FameNode } from '../node.js';
import type { NodeEventListener } from '../node-event-listener.js';
import { DeliveryPolicy } from '../../delivery/delivery-policy.js';

class TestDeliveryPolicy extends DeliveryPolicy {
  constructor(private readonly ackRequired: boolean) {
    super();
  }

  override isAckRequired(): boolean {
    return this.ackRequired;
  }
}

const systemInboxFor = (physicalPath: string) => formatAddress('__sys__', physicalPath);

describe('FameNode', () => {
  it('dispatches lifecycle events in priority order', async () => {
    const calls: string[] = [];

    const lowPriority: NodeEventListener = {
      priority: 100,
      async onNodeInitialized() {
        calls.push('init-low');
      },
      async onNodeStarted() {
        calls.push('start-low');
      },
    };

    const highPriority: NodeEventListener = {
      priority: 10,
      async onNodeInitialized() {
        calls.push('init-high');
      },
      async onNodeStarted() {
        calls.push('start-high');
      },
    };

    const node = new FameNode({
      systemId: 'test-node',
      physicalPath: '/test-node',
      eventListeners: [lowPriority, highPriority],
    });

    await node.start();

    expect(calls).toEqual(['init-high', 'init-low', 'start-high', 'start-low']);
    expect(node.sid).toBeDefined();

    await node.stop();
  });

  it('delivers envelopes to registered listeners', async () => {
    const node = new FameNode({
      systemId: 'deliver-node',
      physicalPath: '/deliver-node',
    });

    await node.start();

    const receivedPayloads: Array<Record<string, any>> = [];

    const address = await node.listen('service', async (envelope) => {
      if (envelope.frame.type === 'Data' && typeof envelope.frame.payload === 'object') {
        receivedPayloads.push(envelope.frame.payload as Record<string, any>);
      }
      return null;
    });

    expect(node.hasLocal(address)).toBe(true);

    const envelope = node.envelopeFactory.createEnvelope({
      to: address,
      frame: {
        type: 'Data',
        payload: { message: 'hello' },
      },
    });

    await node.deliver(envelope);

    expect(receivedPayloads).toEqual([{ message: 'hello' }]);

    await node.stop();
  });

  it('waits for an ack when policy requires it', async () => {
    const node = new FameNode({
      systemId: 'ack-node',
      physicalPath: '/ack-node',
      deliveryPolicy: new TestDeliveryPolicy(true),
    });

    await node.start();
    try {
      const envelope = node.envelopeFactory.createEnvelope({
        to: formatAddress('service', node.physicalPath),
        frame: { type: 'Data', payload: { value: 1 } },
      });

      const tracker = (node as any)._deliveryTracker;
      const ackFrame = await node.send(
        envelope,
        undefined,
        undefined,
        async (env) => {
          const ackEnvelope = node.envelopeFactory.createEnvelope({
            to: systemInboxFor(node.physicalPath),
            frame: { type: 'DeliveryAck', ok: true, refId: env.id },
            ...(env.corrId ? { corrId: env.corrId } : {}),
          });

          await tracker.onEnvelopeDelivered('__sys__', ackEnvelope);
        }
      );

      expect(ackFrame?.type).toBe('DeliveryAck');
      expect(ackFrame?.ok).toBe(true);
  expect(envelope.replyTo).toEqual(systemInboxFor(node.physicalPath));
      expect(envelope.rtype).toBe(FameResponseType.ACK);
    } finally {
      await node.stop();
    }
  });

  it('adds an ack flag when replies are requested', async () => {
    const node = new FameNode({
      systemId: 'reply-ack-node',
      physicalPath: '/reply-ack-node',
      deliveryPolicy: new TestDeliveryPolicy(true),
    });

    await node.start();
    try {
      const envelope = node.envelopeFactory.createEnvelope({
        to: formatAddress('service', node.physicalPath),
        frame: { type: 'Data', payload: { value: 2 } },
        responseType: FameResponseType.REPLY,
      });

      const tracker = (node as any)._deliveryTracker;
      const ackFrame = await node.send(
        envelope,
        undefined,
        undefined,
        async (env) => {
          const replyEnvelope = node.envelopeFactory.createEnvelope({
            to: env.replyTo!,
            frame: { type: 'Data', payload: { value: 'reply' } },
            ...(env.corrId ? { corrId: env.corrId } : {}),
          });

          await tracker.onEnvelopeDelivered('__sys__', replyEnvelope);
        }
      );

      expect(ackFrame?.ok).toBe(true);
      expect(envelope.rtype).toBe(FameResponseType.REPLY | FameResponseType.ACK);
  expect(envelope.replyTo).toEqual(systemInboxFor(node.physicalPath));
    } finally {
      await node.stop();
    }
  });

  it('rejects sending with a non-local origin context', async () => {
    const node = new FameNode({
      systemId: 'context-node',
      physicalPath: '/context-node',
    });

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('service', node.physicalPath),
      frame: { type: 'Data', payload: { value: 3 } },
    });

    await expect(
      node.send(envelope, { originType: DeliveryOriginType.UPSTREAM } as any)
    ).rejects.toThrow('Can only send with LOCAL origin context');
  });

  it('skips tracking when neither acks nor replies are required', async () => {
    const policy = new TestDeliveryPolicy(false);
    const node = new FameNode({
      systemId: 'no-ack-node',
      physicalPath: '/no-ack-node',
      deliveryPolicy: policy,
    });

    const tracker = (node as any)._deliveryTracker;
    const trackSpy = jest.spyOn(tracker, 'track');
    const deliverFn = jest.fn().mockResolvedValue(undefined);

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('service', node.physicalPath),
      frame: { type: 'Data', payload: { value: 4 } },
    });

    const result = await node.send(envelope, undefined, policy, deliverFn);

    expect(result).toBeNull();
    expect(trackSpy).not.toHaveBeenCalled();
    expect(deliverFn).toHaveBeenCalledTimes(1);
    expect(deliverFn.mock.calls[0][1]?.originType).toBe(DeliveryOriginType.LOCAL);
  expect((deliverFn.mock.calls[0][1]?.fromConnector) ?? null).toBeNull();

    trackSpy.mockRestore();
  });

  it('routes delivery acknowledgements through the delivery tracker', async () => {
    const node = new FameNode({
      systemId: 'deliver-ack-node',
      physicalPath: '/deliver-ack-node',
    });

    await node.start();
    const tracker = (node as any)._deliveryTracker;
    const spy = jest.spyOn(tracker, 'onEnvelopeDelivered');

    try {
      const ackEnvelope = node.envelopeFactory.createEnvelope({
        to: systemInboxFor(node.physicalPath),
        frame: { type: 'DeliveryAck', ok: true, refId: 'missing' },
        corrId: 'ack-corr-id',
      });

      await node.deliver(ackEnvelope);

  expect(spy).toHaveBeenCalledWith('__sys__', ackEnvelope, undefined);
    } finally {
      spy.mockRestore();
      await node.stop();
    }
  });
});