import {
  createFameEnvelope,
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
  formatAddressFromComponents,
} from '@naylence/core';
import { withEnvelopeContext } from '../../util/envelope-context.js';
import { BindingManager, type BindingStoreEntry } from '../binding-manager.js';
import { DeliveryTracker } from '../../delivery/delivery-tracker.js';
import { InMemoryKeyValueStore } from '../../storage/in-memory-storage.js';

type ForwardCall = {
  envelope: FameEnvelope;
  context?: FameDeliveryContext;
};

describe('BindingManager', () => {
  let deliveryTracker: DeliveryTracker;
  let forwardCalls: ForwardCall[];
  let bindingStore: InMemoryKeyValueStore<BindingStoreEntry>;

  beforeEach(() => {
    deliveryTracker = new DeliveryTracker();
    forwardCalls = [];
    bindingStore = new InMemoryKeyValueStore<BindingStoreEntry>();
  });

  function createManager(
    options: {
      hasUpstream?: boolean;
      acceptedLogicals?: Iterable<string>;
      encryptionKeyId?: string | null;
      customizeAck?: (
        request: FameEnvelope,
        ack: FameEnvelope | null
      ) => FameEnvelope | null;
    } = {}
  ) {
    let manager: BindingManager;

    const forwardUpstream = async (
      envelope: FameEnvelope,
      context?: FameDeliveryContext
    ) => {
      const call: ForwardCall = { envelope };
      if (context) {
        call.context = context;
      }
      forwardCalls.push(call);
      let ackEnvelope = createAckEnvelope(envelope);
      if (options.customizeAck) {
        ackEnvelope = options.customizeAck(envelope, ackEnvelope);
      }
      if (ackEnvelope) {
        await manager.handleAck(ackEnvelope, context);
      }
    };

    const managerOptions = {
      hasUpstream: options.hasUpstream ?? false,
      getId: () => 'node-1',
      getPhysicalPath: () => '/node-1',
      getAcceptedLogicals: () => new Set(options.acceptedLogicals ?? []),
      forwardUpstream,
      envelopeFactory: {
        createEnvelope: createFameEnvelope,
      },
      deliveryTracker,
      getEncryptionKeyId: () => options.encryptionKeyId ?? null,
      bindingStore,
    } satisfies ConstructorParameters<typeof BindingManager>[0];

    manager = new BindingManager(managerOptions);
    return manager;
  }

  function addressToString(
    address: string | FameAddress | undefined
  ): string | undefined {
    if (address === undefined) {
      return undefined;
    }
    return typeof address === 'string' ? address : address.toString();
  }

  function createAckEnvelope(request: FameEnvelope): FameEnvelope | null {
    const baseProps = {
      corrId: request.id,
      responseType: FameResponseType.ACK,
    } as const;

    switch (request.frame.type) {
      case 'AddressBind':
        return createFameEnvelope({
          ...baseProps,
          frame: {
            type: 'AddressBindAck',
            address: addressToString(request.frame.address)!,
            ok: true,
          },
        });
      case 'AddressUnbind':
        return createFameEnvelope({
          ...baseProps,
          frame: {
            type: 'AddressUnbindAck',
            address: addressToString(request.frame.address)!,
            ok: true,
          },
        });
      case 'CapabilityAdvertise':
        return createFameEnvelope({
          ...baseProps,
          frame: {
            type: 'CapabilityAdvertiseAck',
            address: addressToString(request.frame.address)!,
            capabilities: request.frame.capabilities,
            ok: true,
          },
        });
      case 'CapabilityWithdraw':
        return createFameEnvelope({
          ...baseProps,
          frame: {
            type: 'CapabilityWithdrawAck',
            address: addressToString(request.frame.address)!,
            capabilities: request.frame.capabilities,
            ok: true,
          },
        });
      default:
        return null;
    }
  }

  it('supports snake_case option aliases', async () => {
    const manager = new BindingManager({
      has_upstream: false,
      get_id: () => 'node-1',
      get_physical_path: () => '/node-1',
      get_accepted_logicals: () => new Set<string>(),
      forward_upstream: async () => {
        /* no-op */
      },
      envelope_factory: {
        createEnvelope: createFameEnvelope,
      },
      delivery_tracker: new DeliveryTracker(),
    });

    await manager.bind('service');

    expect(manager.hasBinding('service@/node-1')).toBe(true);
  });

  it('binds local participant without upstream', async () => {
    const manager = createManager();
    const binding = await manager.bind('service');

    expect(binding.address.toString()).toBe('service@/node-1');
    expect(manager.hasBinding('service@/node-1')).toBe(true);
    expect(forwardCalls).toHaveLength(0);

    const persisted = await bindingStore.list();
    expect(Object.keys(persisted)).toContain('service@/node-1');
  });

  it('binds host logical and propagates upstream with ack', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
    });

    await manager.bind('svc@api.service');

    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0].envelope.frame.type).toBe('AddressBind');
    expect(manager.hasBinding('svc@api.service')).toBe(true);
  });

  it('binds pool logical and advertises capabilities', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
    });

    await manager.bind('svc@node.service.domain', ['alpha']);

    expect(forwardCalls.map((call) => call.envelope.frame.type)).toEqual([
      'AddressBind',
      'CapabilityAdvertise',
    ]);

    expect(manager.hasBinding('svc@node.service.domain')).toBe(true);
    expect(manager.hasBinding('svc@node-1.service.domain')).toBe(true);
  });

  it('binds wildcard claim using participant host wildcard', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
    });

    await manager.bind('svc@*.service.domain');

    expect(forwardCalls[0].envelope.frame.type).toBe('AddressBind');
    expect(manager.hasBinding('svc@*.service.domain')).toBe(true);
    expect(manager.hasBinding('svc@node-1.service.domain')).toBe(true);
  });

  it('throws when upstream bind ack is rejected', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
      customizeAck: (request, ack) => {
        if (request.frame.type === 'AddressBind' && ack) {
          (ack.frame as any).ok = false;
        }
        return ack;
      },
    });

    await expect(manager.bind('svc@api.service')).rejects.toThrow(
      "Bind to 'svc@api.service' was rejected"
    );
    expect(manager.hasBinding('svc@api.service')).toBe(false);
  });

  it('rejects binding when location is not permitted', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
    });

    await expect(manager.bind('svc@other.service')).rejects.toThrow(
      "Cannot bind 'svc@other.service': location 'other.service' not permitted"
    );
    expect(forwardCalls).toHaveLength(0);
  });

  it('throws when capability advertise ack is rejected', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
      customizeAck: (request, ack) => {
        if (request.frame.type === 'CapabilityAdvertise' && ack) {
          (ack.frame as any).ok = false;
        }
        return ack;
      },
    });

    await expect(
      manager.bind('svc@node.service.domain', ['alpha'])
    ).rejects.toThrow('Capability advertise rejected: alpha');
    expect(manager.hasBinding('svc@node.service.domain')).toBe(false);
  });

  it('removes withdrawn capabilities from tracking', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
    });

    await manager.bind('svc@node.service.domain', ['alpha', 'beta']);

    const instanceAddress = formatAddressFromComponents(
      'svc',
      'node-1.service.domain'
    );
    await manager.withdrawCapabilities(instanceAddress, ['alpha']);

    await manager.withdrawCapabilities(instanceAddress, ['beta']);
    expect(manager.hasBinding('svc@node.service.domain')).toBe(true);
  });

  it('rolls back binding when upstream rejects', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
    });

    const rejectSpy = jest
      .spyOn<any, any>(manager, 'sendAndWaitForAck')
      .mockImplementation(async () => {
        throw new Error('nack');
      });

    await expect(manager.bind('svc@api.service')).rejects.toThrow('nack');
    expect(manager.hasBinding('svc@api.service')).toBe(false);
    rejectSpy.mockRestore();
  });

  it('unbinds participant and propagates withdraw', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
    });

    await manager.bind('svc@node.service.domain', ['alpha']);
    forwardCalls.length = 0;

    await manager.unbind('svc@node.service.domain');

    expect(forwardCalls.map((call) => call.envelope.frame.type)).toEqual([
      'CapabilityWithdraw',
      'AddressUnbind',
    ]);
    expect(manager.hasBinding('svc@node.service.domain')).toBe(false);
  });

  it('throws when capability withdraw ack is rejected', async () => {
    let failWithdraw = false;
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
      customizeAck: (request, ack) => {
        if (
          request.frame.type === 'CapabilityWithdraw' &&
          ack &&
          failWithdraw
        ) {
          (ack.frame as any).ok = false;
        }
        return ack;
      },
    });

    await manager.bind('svc@node.service.domain', ['alpha']);

    failWithdraw = true;
    const instanceAddress = formatAddressFromComponents(
      'svc',
      'node-1.service.domain'
    );
    await expect(
      manager.withdrawCapabilities(instanceAddress, ['alpha'])
    ).rejects.toThrow('Capability withdraw rejected: alpha');
  });

  it('skips capability advertise when no capabilities provided', async () => {
    const manager = createManager({ hasUpstream: true });
    const advertise = (manager as any).advertiseCapabilities.bind(manager);

    await advertise(new FameAddress('svc@/node-1'), []);

    expect(forwardCalls).toHaveLength(0);
  });

  it('returns when withdrawing capabilities for untracked address', async () => {
    const manager = createManager({ hasUpstream: true });

    await manager.withdrawCapabilities(new FameAddress('svc@/node-1'), [
      'alpha',
    ]);

    expect(forwardCalls[0].envelope.frame.type).toBe('CapabilityWithdraw');
  });

  it('restores persisted bindings and rebinds upstream', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
    });

    await bindingStore.set('svc@api.service', {
      address: 'svc@api.service',
    });

    await manager.restore();

    expect(manager.hasBinding('svc@api.service')).toBe(true);
    expect(forwardCalls[0].envelope.frame.type).toBe('AddressBind');
  });

  it('skips rebind for path addresses during restore', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
    });

    await bindingStore.set('svc@/node-1', {
      address: 'svc@/node-1',
    });

    await manager.restore();

    expect(forwardCalls).toHaveLength(0);
    expect(manager.hasBinding('svc@/node-1')).toBe(true);
  });

  it('applies trace id from envelope context when sending upstream', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['api.service'],
    });

    await withEnvelopeContext({ traceId: 'trace-123' }, () =>
      manager.bind('svc@api.service')
    );

    expect(forwardCalls[0].envelope.traceId).toBe('trace-123');
  });

  it('handles accepted logicals iterable snapshot conversion', async () => {
    const manager = createManager({ hasUpstream: true });
    (manager as any).getAcceptedLogicalsFn = () => ['*.service.domain'];

    await manager.bind('svc@node.service.domain', ['alpha']);

    expect(manager.hasBinding('svc@node.service.domain')).toBe(true);
  });

  it('skips empty capability sets during readvertise', async () => {
    const manager = createManager({ hasUpstream: true });
    (manager as any).capabilitiesByAddress.set('svc@/node-1', new Set());

    await manager.readvertiseCapabilitiesUpstream();

    expect(forwardCalls).toHaveLength(0);
  });

  it('continues readvertise when advertise replay fails', async () => {
    const manager = createManager({ hasUpstream: true });
    const spy = jest
      .spyOn<any, any>(manager as any, 'advertiseCapabilities')
      .mockImplementation(async () => {
        throw new Error('replay failed');
      });
    (manager as any).capabilitiesByAddress.set(
      'svc@/node-1',
      new Set(['alpha'])
    );

    await manager.readvertiseCapabilitiesUpstream();

    expect(spy).toHaveBeenCalledWith(new FameAddress('svc@/node-1'), ['alpha']);
    spy.mockRestore();
  });

  it('matchPool returns undefined for path-based addresses', () => {
    const manager = createManager();

    const result = (manager as any).matchPool('svc@/node-1');

    expect(result).toBeUndefined();
  });

  it('matchHostPool ignores unparsable stored bindings', async () => {
    const manager = createManager({
      hasUpstream: true,
      acceptedLogicals: ['*.service.domain'],
    });

    await manager.bind('svc@node.service.domain', ['alpha']);
    const bindings: Map<string, unknown> = (manager as any).bindings;
    const firstBinding = bindings.values().next().value;
    bindings.set('invalid-binding', firstBinding);

    const matched = (manager as any).matchHostPool(
      'svc',
      'node.service.domain'
    );

    expect(matched).toBeDefined();
  });

  it('computePropagateAddress returns null without upstream', () => {
    const manager = createManager();
    const compute = (manager as any).computePropagateAddress.bind(manager);

    const result = compute(new FameAddress('svc@/node-1'), '*.service.domain');

    expect(result).toBeNull();
  });
});
