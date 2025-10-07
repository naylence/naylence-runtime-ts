import {
  DeliveryOriginType,
  FameResponseType,
  formatAddress,
} from 'naylence-core';
import type {
  FameAddress,
  FameConnector,
  NodeWelcomeFrame,
} from 'naylence-core';
import { FameNode } from '../node.js';
import type { NodeEventListener } from '../node-event-listener.js';
import { DeliveryPolicy } from '../../delivery/delivery-policy.js';
import { RetryPolicy } from '../../delivery/retry-policy.js';
import { InMemoryStorageProvider } from '../../storage/in-memory-storage.js';
import { NODE_META_NAMESPACE, NodeMetaRecord } from '../node-meta.js';
import type { ServiceManager } from '../../service/service-manager.js';
import { TransportListener } from '../../connector/transport-listener.js';
import type { AttachInfo } from '../admission/node-attach-client.js';

class TestDeliveryPolicy extends DeliveryPolicy {
  constructor(private readonly ackRequired: boolean) {
    super();
  }

  override isAckRequired(): boolean {
    return this.ackRequired;
  }
}

const systemInboxFor = (physicalPath: string) =>
  formatAddress('__sys__', physicalPath);

class TestTransportListener extends TransportListener {
  constructor(private readonly grant: Record<string, any>) {
    super();
  }

  override async onNodeStarted(): Promise<void> {
    // no-op for tests
  }

  override async onNodeStopped(): Promise<void> {
    // no-op for tests
  }

  override asCallbackGrant(): Record<string, any> | null {
    return this.grant;
  }
}

class StubServiceManager implements ServiceManager {
  public readonly start = jest.fn(async () => {});
  public readonly stop = jest.fn(async () => {});
  public readonly registerService = jest.fn(async () => {
    throw new Error('registerService not implemented in StubServiceManager');
  });
  public readonly getLocalServices = jest.fn(() => new Map<FameAddress, any>());
  public readonly resolveByCapability = jest.fn(() => {
    throw new Error(
      'resolveByCapability not implemented in StubServiceManager'
    );
  });

  private resolvedAddress: FameAddress | null = null;
  public readonly resolveAddressByCapabilityCalls: string[][] = [];

  setResolvedAddress(address: FameAddress): void {
    this.resolvedAddress = address;
  }

  async resolveAddressByCapability(
    capabilities: string[]
  ): Promise<FameAddress | null> {
    this.resolveAddressByCapabilityCalls.push([...capabilities]);
    return this.resolvedAddress;
  }
}

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

  it('persists node metadata on startup', async () => {
    const storageProvider = new InMemoryStorageProvider();
    const node = new FameNode({
      systemId: 'meta-node',
      physicalPath: '/meta-node',
      storageProvider,
    });

    await node.start();

    const store = await storageProvider.getKeyValueStore(
      NodeMetaRecord,
      NODE_META_NAMESPACE
    );
    const meta = await store.get('self');

    expect(meta).toBeDefined();
    expect(meta?.id).toBe('meta-node');

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
      if (
        envelope.frame.type === 'Data' &&
        typeof envelope.frame.payload === 'object'
      ) {
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

  it('collects callback grants from transport and event listeners without duplicates', () => {
    const transportGrant = { type: 'transport', url: 'ws://transport' };
    const transportListener = new TestTransportListener(transportGrant);
    const duplicateGrant = { type: 'transport', url: 'ws://transport' };
    const uniqueGrant = { type: 'callback', url: 'https://callback' };

    const node = new FameNode({
      systemId: 'callback-node',
      physicalPath: '/callback-node',
      transportListeners: [transportListener],
      eventListeners: [
        {
          priority: 50,
          asCallbackGrant: () => duplicateGrant,
        } as unknown as NodeEventListener,
        {
          priority: 60,
          asCallbackGrant: () => uniqueGrant,
        } as unknown as NodeEventListener,
      ],
    });

    const grants = node.gatherSupportedCallbackGrants();

    expect(grants).toContainEqual(transportGrant);
    expect(grants).toContainEqual(uniqueGrant);
    expect(grants.filter((grant) => grant.type === 'transport')).toHaveLength(
      1
    );
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
      expect(envelope.rtype).toBe(
        FameResponseType.REPLY | FameResponseType.ACK
      );
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
    expect(deliverFn.mock.calls[0][1]?.originType).toBe(
      DeliveryOriginType.LOCAL
    );
    expect(deliverFn.mock.calls[0][1]?.fromConnector ?? null).toBeNull();

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

  it('throws when start is invoked twice', async () => {
    const node = new FameNode({
      systemId: 'double-start-node',
      physicalPath: '/double-start-node',
    });

    await node.start();
    await expect(node.start()).rejects.toThrow('Node already started');
    await node.stop();
  });

  it('stopping before start is a no-op', async () => {
    const node = new FameNode({
      systemId: 'pre-stop-node',
      physicalPath: '/pre-stop-node',
    });
    const dispatchSpy = jest.spyOn(node as any, 'dispatchEvent');

    await node.stop();

    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('ignores duplicate event listeners', () => {
    const node = new FameNode({
      systemId: 'dedupe-node',
      physicalPath: '/dedupe-node',
    });
    const listener = { priority: 50 } as NodeEventListener;

    node.addEventListener(listener);
    node.addEventListener(listener);

    const occurrences = node.eventListeners.filter((l) => l === listener);
    expect(occurrences).toHaveLength(1);
  });

  it('forwards upstream for control frames', async () => {
    const node = new FameNode({
      systemId: 'control-frame-node',
      physicalPath: '/control-frame-node',
    });
    const forwardSpy = jest
      .spyOn(node as any, 'forwardUpstream')
      .mockResolvedValue(undefined);

    const envelope = node.envelopeFactory.createEnvelope({
      frame: {
        type: 'AddressBind',
        address: formatAddress('svc', node.physicalPath).toString(),
      },
    });

    await node.deliver(envelope);

    expect(forwardSpy).toHaveBeenCalledTimes(1);
    const [[forwarded]] = forwardSpy.mock.calls as [[any, any?]];
    expect(forwarded.frame.type).toBe('AddressBind');
    forwardSpy.mockRestore();
  });

  it('routes capability-based envelopes via the service manager', async () => {
    const serviceManager = new StubServiceManager();
    const node = new FameNode({
      systemId: 'capability-node',
      physicalPath: '/capability-node',
      serviceManager,
    });

    await node.start();

    const handler = jest.fn().mockResolvedValue(null);
    const address = await node.listen('cap-service', handler);
    serviceManager.setResolvedAddress(address);

    const envelope = node.envelopeFactory.createEnvelope({
      frame: { type: 'Data', payload: { hello: 'world' } },
      capabilities: ['test-cap'],
    });

    await node.deliver(envelope);

    expect(serviceManager.start).toHaveBeenCalled();
    expect(serviceManager.resolveAddressByCapabilityCalls).toEqual([
      ['test-cap'],
    ]);
    expect(handler).toHaveBeenCalledTimes(1);

    await node.stop();
  });

  it('captures welcome expiration metadata for root nodes', async () => {
    const node = new FameNode({
      systemId: 'root-node',
      physicalPath: '/root-node',
    });

    expect(node.handshakeCompleted).toBe(true);
    expect(node.welcomeExpiresAt).toBeNull();

    const welcome: NodeWelcomeFrame = {
      type: 'NodeWelcome',
      systemId: 'root-node',
      instanceId: 'instance-123',
      expiresAt: '2025-01-01T00:00:00.000Z',
    };

    await (node as any).handleWelcome(welcome);

    expect(node.welcomeExpiresAt).toBe('2025-01-01T00:00:00.000Z');
    expect(node.handshakeCompleted).toBe(true);
    expect(node.attachExpiresAt).toBeNull();
  });

  it('tracks attach expiration and handshake completion for upstream nodes', async () => {
    const node = new FameNode({
      systemId: 'child-node',
      physicalPath: '/child-node',
      hasParent: true,
    });

    expect(node.handshakeCompleted).toBe(false);
    expect(node.attachExpiresAt).toBeNull();

    const attachExpiresAt = new Date('2025-02-01T12:00:00.000Z');
    const attachInfo: AttachInfo = {
      systemId: 'child-node',
      targetSystemId: 'parent-node',
      targetPhysicalPath: '/parent-node',
      assignedPath: '/child-node',
      attachExpiresAt,
    };

    const connector = {} as FameConnector;

    await (node as any).handleAttach(attachInfo, connector);

    expect(node.handshakeCompleted).toBe(true);
    expect(node.attachExpiresAt).toBe(attachExpiresAt);
    expect(node.welcomeExpiresAt).toBeNull();
  });

  it('ignores envelopes without a destination when no capability is provided', async () => {
    const node = new FameNode({
      systemId: 'missing-address-node',
      physicalPath: '/missing-address-node',
    });

    const envelope = node.envelopeFactory.createEnvelope({
      frame: { type: 'Data', payload: {} },
    });

    await expect(node.deliver(envelope)).resolves.toBeUndefined();
  });

  it('forwards upstream when the origin context is local', async () => {
    const node = new FameNode({
      systemId: 'local-origin-node',
      physicalPath: '/local-origin-node',
    });
    const forwardSpy = jest
      .spyOn(node as any, 'forwardUpstream')
      .mockResolvedValue(undefined);

    (node as any)._upstreamConnector = {};

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', '/elsewhere'),
      frame: { type: 'Data', payload: {} },
    });
    const context = {
      originType: DeliveryOriginType.LOCAL,
      fromConnector: null,
    } as any;

    await node.deliver(envelope, context);

    expect(forwardSpy).toHaveBeenCalledTimes(1);
    forwardSpy.mockRestore();
  });

  it('does not forward upstream when the origin context is upstream', async () => {
    const node = new FameNode({
      systemId: 'no-handler-node',
      physicalPath: '/no-handler-node',
    });

    const forwardSpy = jest
      .spyOn(node as any, 'forwardUpstream')
      .mockResolvedValue(undefined);

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', '/remote-node'),
      frame: { type: 'Data', payload: {} },
    });
    const context = {
      originType: DeliveryOriginType.UPSTREAM,
      fromConnector: null,
    } as any;

    await expect(node.deliver(envelope, context)).resolves.toBeUndefined();
    expect(forwardSpy).not.toHaveBeenCalled();

    forwardSpy.mockRestore();
  });

  it('halts delivery when a listener returns null', async () => {
    const node = new FameNode({
      systemId: 'listener-null-node',
      physicalPath: '/listener-null-node',
      eventListeners: [
        {
          priority: 1,
          async onDeliver() {
            return null;
          },
        } as NodeEventListener,
      ],
    });
    const deliverSpy = jest.spyOn(
      (node as any)._envelopeListenerManager,
      'deliverToAddress'
    );

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', node.physicalPath),
      frame: { type: 'Data', payload: {} },
    });

    await node.deliver(envelope);

    expect(deliverSpy).not.toHaveBeenCalled();
    deliverSpy.mockRestore();
  });

  it('delivers local envelopes through the channel polling queue', async () => {
    const node = new FameNode({
      systemId: 'channel-local-node',
      physicalPath: '/channel-local-node',
    });

    await node.start();

    try {
      const handler = jest.fn().mockResolvedValue(null);
      const address = await node.listen('service', handler);
      const bindingManager = (node as any)._bindingManager;
      const binding = bindingManager.getBinding(address);
      expect(binding).toBeDefined();

      const sendSpy = jest
        .spyOn(binding.channel, 'send')
        .mockResolvedValue(undefined);

      const envelope = node.envelopeFactory.createEnvelope({
        frame: { type: 'Data', payload: { value: 'queued' } },
      });

      await node.deliverLocal(address, envelope);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [channelMessage] = sendSpy.mock.calls[0];
      if (channelMessage === envelope) {
        expect((channelMessage as any).id).toBe(envelope.id);
      } else {
        expect((channelMessage as any)?.envelope?.id).toBe(envelope.id);
      }

      sendSpy.mockRestore();
    } finally {
      await node.stop();
    }
  });

  it('throws when ack frame type is unexpected', async () => {
    const node = new FameNode({
      systemId: 'bad-ack-node',
      physicalPath: '/bad-ack-node',
      deliveryPolicy: new TestDeliveryPolicy(true),
    });

    const stubTracker = {
      priority: 100,
      track: jest.fn().mockResolvedValue(undefined),
      awaitAck: jest
        .fn()
        .mockResolvedValue(
          node.envelopeFactory.createEnvelope({
            frame: { type: 'Data', payload: {} },
          })
        ),
      onEnvelopeDelivered: jest.fn().mockResolvedValue(undefined),
    };
    (node as any)._deliveryTracker = stubTracker;

    const deliverFn = jest.fn().mockResolvedValue(undefined);

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', node.physicalPath),
      frame: { type: 'Data', payload: {} },
    });

    await expect(
      node.send(envelope, undefined, undefined, deliverFn)
    ).rejects.toThrow('Expected DeliveryAck frame in acknowledgement');

    expect(stubTracker.awaitAck).toHaveBeenCalled();
  });

  it('tracks upstream acknowledgement frames', async () => {
    const node = new FameNode({
      systemId: 'ack-tracker-node',
      physicalPath: '/ack-tracker-node',
    });
    const stubTracker = {
      priority: 100,
      onEnvelopeDelivered: jest.fn().mockResolvedValue(undefined),
    };
    (node as any)._deliveryTracker = stubTracker;

    const frame = {
      type: 'AddressBindAck',
      address: formatAddress('svc', node.physicalPath).toString(),
      ok: true,
    } as any;
    const envelope = node.envelopeFactory.createEnvelope({
      frame,
    });

    await node.deliver(envelope);

    expect(stubTracker.onEnvelopeDelivered).toHaveBeenCalledWith(
      '__sys__',
      envelope,
      undefined
    );
  });

  it('records the timestamp of the last received heartbeat', async () => {
    const node = new FameNode({
      systemId: 'heartbeat-node',
      physicalPath: '/heartbeat-node',
    });

    expect(node.lastHeartbeatAt).toBeNull();

    const envelope = node.envelopeFactory.createEnvelope({
      frame: {
        type: 'NodeHeartbeat',
      },
    });

    await (node as any).handleSystemFrame(envelope);

    expect(node.lastHeartbeatAt).not.toBeNull();
  });

  it('short-circuits deliverLocal when listeners return null', async () => {
    const node = new FameNode({
      systemId: 'deliver-local-node',
      physicalPath: '/deliver-local-node',
      eventListeners: [
        {
          priority: 1,
          async onDeliverLocal() {
            return null;
          },
        } as NodeEventListener,
      ],
    });
    const deliverSpy = jest.spyOn(
      (node as any)._envelopeListenerManager,
      'deliverToAddress'
    );

    const address = formatAddress('svc', node.physicalPath);
    const envelope = node.envelopeFactory.createEnvelope({
      frame: { type: 'Data', payload: {} },
    });

    await node.deliverLocal(address, envelope);

    expect(deliverSpy).not.toHaveBeenCalled();
    deliverSpy.mockRestore();
  });

  it('stops forwarding when upstream listeners return null', async () => {
    const endListener: NodeEventListener = {
      priority: 5,
      async onForwardUpstreamComplete() {
        throw new Error('should not be called');
      },
    };
    const endSpy = jest.spyOn(endListener, 'onForwardUpstreamComplete');
    const node = new FameNode({
      systemId: 'forward-null-node',
      physicalPath: '/forward-null-node',
      eventListeners: [
        {
          priority: 1,
          async onForwardUpstream() {
            return null;
          },
        } as NodeEventListener,
        endListener,
      ],
    });

    const envelope = node.envelopeFactory.createEnvelope({
      frame: {
        type: 'NodeHeartbeat',
        address: formatAddress('svc', node.physicalPath).toString(),
      },
    });

    await node.forwardUpstream(envelope);

    expect(endSpy).not.toHaveBeenCalled();
    endSpy.mockRestore();
  });

  it('propagates envelope mutations through upstream listeners', async () => {
    const seen: string[] = [];
    const node = new FameNode({
      systemId: 'forward-mutate-node',
      physicalPath: '/forward-mutate-node',
      eventListeners: [
        {
          priority: 1,
          async onForwardUpstream(_node, env) {
            const next = {
              ...env,
              meta: { ...(env.meta ?? {}), marker: 'mutated' },
            } as typeof env;
            return next;
          },
        } as NodeEventListener,
        {
          priority: 2,
          async onForwardUpstreamComplete(_node, env) {
            seen.push((env.frame as any).marker ?? 'missing');
            seen.push(String(env.meta?.marker ?? 'missing-meta'));
            return env;
          },
        } as NodeEventListener,
      ],
    });

    const envelope = node.envelopeFactory.createEnvelope({
      frame: {
        type: 'NodeHeartbeat',
        address: formatAddress('svc', node.physicalPath).toString(),
      },
    });

    await node.forwardUpstream(envelope);

    expect(seen).toEqual(['missing', 'mutated']);
  });

  describe('hasLocal', () => {
    it('returns true when a binding exists', () => {
      const node = new FameNode({
        systemId: 'has-local-binding',
        physicalPath: '/has-local-binding',
      });
      const manager = (node as any)._bindingManager;
      const spy = jest.spyOn(manager, 'hasBinding').mockReturnValue(true);

      expect(node.hasLocal(formatAddress('svc', '/other'))).toBe(true);
      spy.mockRestore();
    });

    it('returns true when address matches physical path', () => {
      const node = new FameNode({
        systemId: 'has-local-match',
        physicalPath: '/has-local-match',
      });
      const manager = (node as any)._bindingManager;
      const spy = jest.spyOn(manager, 'hasBinding').mockReturnValue(false);

      expect(node.hasLocal(formatAddress('svc', node.physicalPath))).toBe(true);
      spy.mockRestore();
    });

    it('returns false for different locations', () => {
      const node = new FameNode({
        systemId: 'has-local-remote',
        physicalPath: '/has-local-remote',
      });
      const manager = (node as any)._bindingManager;
      const spy = jest.spyOn(manager, 'hasBinding').mockReturnValue(false);

      expect(node.hasLocal(formatAddress('svc', '/elsewhere'))).toBe(false);
      spy.mockRestore();
    });

    it('returns false when address parsing fails', () => {
      const node = new FameNode({
        systemId: 'has-local-invalid',
        physicalPath: '/has-local-invalid',
      });
      const manager = (node as any)._bindingManager;
      const spy = jest.spyOn(manager, 'hasBinding').mockReturnValue(false);

      expect(node.hasLocal('invalid-address')).toBe(false);
      spy.mockRestore();
    });
  });

  it('throws when dispatchEnvelopeEvent lacks an envelope', async () => {
    const node = new FameNode({
      systemId: 'dispatch-error-node',
      physicalPath: '/dispatch-error-node',
    });

    await expect(
      (node as any).dispatchEnvelopeEvent('onDeliver')
    ).rejects.toThrow(
      'dispatchEnvelopeEvent(onDeliver) requires an envelope argument'
    );
  });

  it('removes event listeners by reference', () => {
    const listener = { priority: 10 } as NodeEventListener;
    const node = new FameNode({
      systemId: 'remove-listener-node',
      physicalPath: '/remove-listener-node',
      eventListeners: [listener],
    });

    node.removeEventListener(listener);

    expect(node.eventListeners).not.toContain(listener);
  });

  it('dispatches stop events after starting', async () => {
    const calls: string[] = [];
    const listener: NodeEventListener = {
      priority: 1,
      async onNodeInitialized() {
        calls.push('init');
      },
      async onNodeStarted() {
        calls.push('started');
      },
      async onNodePreparingToStop() {
        calls.push('pre-stop');
      },
      async onNodeStopped() {
        calls.push('stopped');
      },
    };

    const node = new FameNode({
      systemId: 'stop-flow-node',
      physicalPath: '/stop-flow-node',
      eventListeners: [listener],
    });

    await node.start();
    await node.stop();

    expect(calls).toEqual(['init', 'started', 'pre-stop', 'stopped']);
  });

  it('delegates bind and unbind to the binding manager', async () => {
    const node = new FameNode({
      systemId: 'binding-node',
      physicalPath: '/binding-node',
    });
    const manager = (node as any)._bindingManager;
    const bindSpy = jest.spyOn(manager, 'bind').mockResolvedValue('ok');
    const unbindSpy = jest
      .spyOn(manager, 'unbind')
      .mockResolvedValue(undefined);

    await node.bind('participant');
    await node.unbind('participant');

    expect(bindSpy).toHaveBeenCalledWith('participant');
    expect(unbindSpy).toHaveBeenCalledWith('participant');
    bindSpy.mockRestore();
    unbindSpy.mockRestore();
  });

  it('delegates envelope listener operations', async () => {
    const node = new FameNode({
      systemId: 'delegation-node',
      physicalPath: '/delegation-node',
    });
    const manager = (node as any)._envelopeListenerManager;

    const listenAddr = formatAddress('svc', node.physicalPath);
    const listenSpy = jest
      .spyOn(manager, 'listen')
      .mockResolvedValue(listenAddr);
    const listenRpcSpy = jest
      .spyOn(manager, 'listenRpc')
      .mockResolvedValue(listenAddr);
    const invokeSpy = jest
      .spyOn(manager, 'invoke')
      .mockResolvedValueOnce('target-result')
      .mockResolvedValueOnce('cap-result');
    const invokeStreamSpy = jest
      .spyOn(manager, 'invokeStream')
      .mockResolvedValueOnce(
        (async function* () {
          yield 'stream-target';
        })()
      )
      .mockResolvedValueOnce(
        (async function* () {
          yield 'stream-cap';
        })()
      );

    const handled = await node.listen('svc', async () => null);
    const rpcAddr = await node.listenRpc('svc', async () => {}, 50);
    const invokeResult = await node.invoke(listenAddr, 'method', {}, 25);
    const capResult = await node.invokeByCapability(['cap'], 'method', {}, 25);

    const streamValues: string[] = [];
    for await (const value of node.invokeStream(listenAddr, 'method', {}, 25)) {
      streamValues.push(value as string);
    }

    const capStreamValues: string[] = [];
    for await (const value of node.invokeByCapabilityStream(
      ['cap'],
      'method',
      {},
      25
    )) {
      capStreamValues.push(value as string);
    }

    expect(handled).toEqual(listenAddr);
    expect(rpcAddr).toEqual(listenAddr);
    expect(invokeResult).toBe('target-result');
    expect(capResult).toBe('cap-result');
    expect(streamValues).toEqual(['stream-target']);
    expect(capStreamValues).toEqual(['stream-cap']);

    listenSpy.mockRestore();
    listenRpcSpy.mockRestore();
    invokeSpy.mockRestore();
    invokeStreamSpy.mockRestore();
  });

  it('rejects send when local context carries a connector reference', async () => {
    const node = new FameNode({
      systemId: 'context-connector-node',
      physicalPath: '/context-connector-node',
    });

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', node.physicalPath),
      frame: { type: 'Data', payload: {} },
    });

    const context = {
      originType: DeliveryOriginType.LOCAL,
      fromConnector: {} as any,
    } as any;

    await expect(node.send(envelope, context)).rejects.toThrow(
      'fromConnector must be null in LOCAL context'
    );
  });

  it('generates trace metadata when replies are required without acks', async () => {
    const policy = new TestDeliveryPolicy(false);
    const node = new FameNode({
      systemId: 'trace-node',
      physicalPath: '/trace-node',
      deliveryPolicy: policy,
    });

    const stubTracker = {
      priority: 10,
      track: jest.fn().mockResolvedValue(undefined),
      awaitAck: jest.fn(),
      onEnvelopeDelivered: jest.fn(),
    };
    (node as any)._deliveryTracker = stubTracker;

    const deliverFn = jest.fn().mockResolvedValue(undefined);
    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', node.physicalPath),
      frame: { type: 'Data', payload: {} },
      responseType: FameResponseType.REPLY,
    });

    envelope.traceId = undefined as any;
    envelope.replyTo = undefined;

    const result = await node.send(envelope, undefined, policy, deliverFn);

    expect(result).toBeNull();
    expect(envelope.traceId).toBeDefined();
    expect(envelope.replyTo).toEqual(systemInboxFor(node.physicalPath));
    expect(stubTracker.track).toHaveBeenCalled();
    expect(deliverFn).toHaveBeenCalled();
  });

  it('returns no supported callback grants by default', () => {
    const node = new FameNode({
      systemId: 'grants-node',
      physicalPath: '/grants-node',
    });

    expect(node.gatherSupportedCallbackGrants()).toEqual([]);
  });

  it('dispatchEnvelopeEvent returns the processed envelope', async () => {
    const node = new FameNode({
      systemId: 'dispatch-node',
      physicalPath: '/dispatch-node',
    });
    const envelope = node.envelopeFactory.createEnvelope({
      frame: { type: 'Data', payload: {} },
    });
    const modified = { ...envelope, corrId: 'mutated' };

    const spy = jest
      .spyOn(node as any, 'runEnvelopeListeners')
      .mockResolvedValue(modified);

    const result = await (node as any).dispatchEnvelopeEvent(
      'onDeliver',
      envelope
    );

    expect(spy).toHaveBeenCalled();
    expect(result?.corrId).toBe('mutated');
    spy.mockRestore();
  });

  it('invokes retry handler when sender retry policy is present', async () => {
    class RetryAwarePolicy extends DeliveryPolicy {
      constructor() {
        super({ senderRetryPolicy: new RetryPolicy({ maxRetries: 1 }) });
      }

      override isAckRequired(): boolean {
        return false;
      }
    }

    const policy = new RetryAwarePolicy();
    const node = new FameNode({
      systemId: 'retry-handler-node',
      physicalPath: '/retry-handler-node',
      deliveryPolicy: policy,
    });

    const deliverFn = jest.fn().mockResolvedValue(undefined);
    const stubTracker = {
      priority: 10,
      track: jest.fn().mockImplementation(async (_env, options) => {
        await options.retryHandler?.onRetryNeeded(
          node.envelopeFactory.createEnvelope({
            frame: { type: 'Data', payload: {} },
          }),
          1,
          10
        );
      }),
      awaitAck: jest.fn(),
      onEnvelopeDelivered: jest.fn(),
    };
    (node as any)._deliveryTracker = stubTracker;

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', node.physicalPath),
      frame: { type: 'Data', payload: {} },
      responseType: FameResponseType.REPLY,
    });
    envelope.traceId = undefined as any;

    await node.send(envelope, undefined, node.deliveryPolicy, deliverFn);

    expect(deliverFn).toHaveBeenCalledTimes(2);
  });

  it('exposes configuration via getters and honors binding store option', () => {
    const bindingStore = {
      list: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const storageProvider = new InMemoryStorageProvider();
    const securityManager = { getEncryptionKeyId: () => 'key-1' };
    const admissionClient = {};
    const policy = new TestDeliveryPolicy(false);

    const node = new FameNode({
      systemId: 'getter-node',
      physicalPath: '/getter-node',
      deliveryPolicy: policy,
      bindingStore: bindingStore as any,
      publicUrl: 'https://example.test',
      acceptedLogicals: ['logic'],
      hasParent: true,
      storageProvider,
      securityManager: securityManager as any,
      admissionClient: admissionClient as any,
    });

    expect(node.id).toBe('getter-node');
    expect(node.sid).toBeTruthy();
    expect(node.physicalPath).toBe('/getter-node');
    expect(node.acceptedLogicals.has('logic')).toBe(true);
    expect(node.deliveryPolicy).toBe(policy);
    expect(node.defaultBindingPath).toBe('/getter-node');
    expect(node.hasParent).toBe(true);
    expect(node.securityManager).toBe(securityManager);
    expect(node.admissionClient).toBe(admissionClient);
    expect(node.eventListeners.length).toBeGreaterThan(0);
    expect(node.upstreamConnector).toBeNull();
    expect(node.publicUrl).toBe('https://example.test');
    expect(node.storageProvider).toBe(storageProvider);
    expect(node.bindingManager).toBe((node as any)._bindingManager);
    expect((node.bindingManager as any).bindingStore).toBe(bindingStore);
  });

  it('normalizes provided local send context', async () => {
    const node = new FameNode({
      systemId: 'context-normalize-node',
      physicalPath: '/context-normalize-node',
    });
    const deliverFn = jest.fn().mockResolvedValue(undefined);

    const envelope = node.envelopeFactory.createEnvelope({
      to: formatAddress('svc', node.physicalPath),
      frame: { type: 'Data', payload: {} },
    });

    const context = {
      originType: DeliveryOriginType.LOCAL,
      fromConnector: null,
      extra: 'value',
    };

    const result = await node.send(envelope, context as any, null, deliverFn);

    expect(result).toBeNull();
    expect(deliverFn).toHaveBeenCalled();
    const [[, effectiveContext]] = deliverFn.mock.calls;
    expect(effectiveContext?.originType).toBe(DeliveryOriginType.LOCAL);
    expect(effectiveContext?.fromConnector).toBeNull();
    expect((effectiveContext as any).extra).toBe('value');
  });
});
