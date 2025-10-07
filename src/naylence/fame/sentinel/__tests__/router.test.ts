import {
  type FameEnvelope,
  type FameAddress,
  type EnvelopeFactory,
} from 'naylence-core';

import {
  Drop,
  ForwardChild,
  ForwardPeer,
  ForwardUp,
  DeliverLocal,
  RouterState,
  emitDeliveryNack,
} from '../router.js';
import { FameTransportClose } from '../../errors/errors.js';

jest.mock('../../util/logging.js', () => {
  const logger = {
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  };

  return {
    getLogger: jest.fn(() => logger),
    summarizeEnvelope: jest.fn(() => ({ summary: 'data' })),
    __loggerMock: logger,
  };
});

const { __loggerMock: loggerMock } = jest.requireMock(
  '../../util/logging.js'
) as {
  __loggerMock: { debug: jest.Mock; warning: jest.Mock; error: jest.Mock };
};

type MutableRouter = {
  deliverLocal: jest.Mock;
  forwardUpstream: jest.Mock;
  forwardToRoute?: jest.Mock;
  forwardToPeer?: jest.Mock;
  removeDownstreamRoute?: jest.Mock;
  removePeerRoute?: jest.Mock;
};

function createRouter(overrides: Partial<MutableRouter> = {}): MutableRouter {
  return {
    deliverLocal: jest.fn(async () => undefined),
    forwardUpstream: jest.fn(async () => undefined),
    forwardToRoute: jest.fn(async () => undefined),
    forwardToPeer: jest.fn(async () => undefined),
    removeDownstreamRoute: jest.fn(async () => undefined),
    removePeerRoute: jest.fn(async () => undefined),
    ...overrides,
  };
}

function createState(
  options?: Partial<ConstructorParameters<typeof RouterState>[0]>
): RouterState {
  const baseOptions: ConstructorParameters<typeof RouterState>[0] = {
    nodeId: 'node-1',
    local: ['svc@/node-1/local'],
    downstreamAddressRoutes: { 'svc@/node-1/local': 'segment-local' },
    peerAddressRoutes: { 'svc@/node-1/peer': 'segment-peer' },
    childSegments: ['child-a'],
    peerSegments: ['peer-a'],
    hasParent: true,
    physicalSegments: ['node-1'],
    pools: new Map(),
    capabilities: {},
    envelopeFactory: {
      createEnvelope: jest.fn((config) => ({
        id: 'generated',
        ...config,
      })),
    } as unknown as EnvelopeFactory,
  };

  return new RouterState({
    ...baseOptions,
    ...(options ?? {}),
  });
}

describe('RoutingAction implementations', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    loggerMock.debug.mockClear();
    loggerMock.error.mockClear();
    loggerMock.warning.mockClear();
  });

  it('Drop emits nack and logs drop', async () => {
    const action = new Drop();

    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/local',
      id: 'drop-id',
      corrId: 'drop-corr',
    } as unknown as FameEnvelope;
    const router = createRouter();
    const state = createState();

    await action.execute(envelope, router as unknown as any, state);

    expect(router.deliverLocal).toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'dropped_envelope',
      expect.any(Object)
    );
  });

  it('ForwardUp forwards upstream with provided context', async () => {
    const action = new ForwardUp();
    const router = createRouter();
    const state = createState();
    const envelope = { frame: { type: 'Data' } } as FameEnvelope;
    const context = { tenant: 'ctx' } as any;

    await action.execute(envelope, router as unknown as any, state, context);

    expect(router.forwardUpstream).toHaveBeenCalledWith(envelope, context);
  });

  it('DeliverLocal routes to provided recipient', async () => {
    const action = new DeliverLocal('svc@/node-1/local');
    const router = createRouter();
    const state = createState();
    const envelope = { frame: { type: 'Data' } } as FameEnvelope;

    await action.execute(envelope, router as unknown as any, state, null);

    expect(router.deliverLocal).toHaveBeenCalledWith(
      'svc@/node-1/local',
      envelope,
      undefined
    );
  });

  it('ForwardChild forwards successfully', async () => {
    const action = new ForwardChild('child-segment');
    const router = createRouter();
    const state = createState();
    const envelope = { frame: { type: 'Data' } } as FameEnvelope;

    await action.execute(envelope, router as unknown as any, state, undefined);

    expect(router.forwardToRoute).toHaveBeenCalledWith(
      'child-segment',
      envelope,
      undefined
    );
  });

  it('ForwardChild handles transport close errors and emits nack', async () => {
    const action = new ForwardChild('child-seg');
    const router = createRouter({
      forwardToRoute: jest.fn(async () => {
        throw new FameTransportClose('closed');
      }),
    });
    const state = createState();
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/local',
      id: 'child-id',
      corrId: 'child-corr',
    } as unknown as FameEnvelope;

    await action.execute(envelope, router as unknown as any, state, undefined);

    expect(router.removeDownstreamRoute).toHaveBeenCalledWith('child-seg');
    expect(router.deliverLocal).toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'transport_closed_forward_child',
      expect.objectContaining({ segment: 'child-seg' })
    );
  });

  it('ForwardChild rethrows non-transport errors', async () => {
    const action = new ForwardChild('child-seg');
    const router = createRouter({
      forwardToRoute: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    const state = createState();
    const envelope = { frame: { type: 'Data' } } as unknown as FameEnvelope;

    await expect(
      action.execute(envelope, router as unknown as any, state, undefined)
    ).rejects.toThrow('boom');
    expect(router.removeDownstreamRoute).not.toHaveBeenCalled();
    expect(router.deliverLocal).not.toHaveBeenCalled();
  });

  it('ForwardPeer handles transport close errors without nack for ack frames', async () => {
    const action = new ForwardPeer('peer-seg');
    const router = createRouter({
      forwardToPeer: jest.fn(async () => {
        throw new FameTransportClose('closed');
      }),
    });
    const state = createState();
    const envelope = {
      frame: { type: 'DeliveryAck' },
    } as unknown as FameEnvelope;

    await action.execute(envelope, router as unknown as any, state, undefined);

    expect(router.removePeerRoute).toHaveBeenCalledWith('peer-seg');
    expect(router.deliverLocal).not.toHaveBeenCalled();
  });

  it('ForwardPeer rethrows non-transport errors', async () => {
    const action = new ForwardPeer('peer-seg');
    const router = createRouter({
      forwardToPeer: jest.fn(async () => {
        throw new Error('fail');
      }),
    });
    const state = createState();
    const envelope = { frame: { type: 'Data' } } as unknown as FameEnvelope;

    await expect(
      action.execute(envelope, router as unknown as any, state, undefined)
    ).rejects.toThrow('fail');
    expect(router.removePeerRoute).not.toHaveBeenCalled();
    expect(router.deliverLocal).not.toHaveBeenCalled();
  });
});

describe('emitDeliveryNack', () => {
  let router: MutableRouter;

  beforeEach(() => {
    router = createRouter();
    loggerMock.debug.mockClear();
    loggerMock.error.mockClear();
    loggerMock.warning.mockClear();
  });

  it('returns early when nack should not be emitted', async () => {
    const state = createState();
    const envelope = {
      frame: { type: 'DeliveryAck' },
      replyTo: 'svc@/node-1/local',
      id: 'id-1',
      corrId: 'corr-1',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      router as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(state.envelopeFactory?.createEnvelope).not.toHaveBeenCalled();
    expect(router.deliverLocal).not.toHaveBeenCalled();
  });

  it('logs warning when envelope factory missing', async () => {
    const state = new RouterState({
      nodeId: 'node-1',
      local: ['svc@/node-1/local'],
      downstreamAddressRoutes: { 'svc@/node-1/local': 'segment-local' },
      peerAddressRoutes: {},
      childSegments: [],
      peerSegments: [],
      hasParent: true,
      physicalSegments: ['node-1'],
      pools: new Map(),
    });
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/local',
      id: 'id-1',
      corrId: 'corr-1',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      router as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'router_missing_envelope_factory',
      expect.any(Object)
    );
  });

  it('delivers nack locally when reply target is local', async () => {
    const state = createState();
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/local',
      id: 'id-1',
      corrId: 'corr-1',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      router as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(router.deliverLocal).toHaveBeenCalled();
    expect(router.forwardToRoute).not.toHaveBeenCalled();
  });

  it('forwards nack to child segment when route exists', async () => {
    const state = createState();
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/child-a/leaf',
      id: 'id-2',
      corrId: 'corr-2',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      router as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(router.forwardToRoute).toHaveBeenCalledWith(
      'child-a',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('forwards nack to peer segment when available', async () => {
    const state = createState({
      peerSegments: ['peer-seg'],
      peerAddressRoutes: { 'svc@/node-1/peer-seg/leaf': 'peer-seg' },
    });
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/peer-seg/leaf',
      id: 'id-3',
      corrId: 'corr-3',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      router as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(router.forwardToPeer).toHaveBeenCalledWith(
      'peer-seg',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('forwards nack upstream when no child or peer match', async () => {
    const state = createState();
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/unknown/leaf',
      id: 'id-4',
      corrId: 'corr-4',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      router as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(router.forwardUpstream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('logs warning when forwarding the nack fails', async () => {
    const failingRouter = createRouter({
      forwardUpstream: jest.fn(async () => {
        throw new Error('send failed');
      }),
    });
    const state = createState();
    const envelope = {
      frame: { type: 'Data' },
      replyTo: 'svc@/node-1/unknown/leaf',
      id: 'id-5',
      corrId: 'corr-5',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      envelope,
      failingRouter as unknown as any,
      state,
      'NO_ROUTE'
    );

    expect(loggerMock.warning).toHaveBeenCalledWith(
      'nack_forward_failed',
      expect.objectContaining({ error: 'send failed' })
    );
  });

  it('creates secure accept nack frames when secure open envelopes fail', async () => {
    const state = createState();
    const secureEnvelope = {
      frame: { type: 'SecureOpen', cid: 'cid', ephPub: 'pub', alg: 'alg' },
      replyTo: 'svc@/node-1/local',
      id: 'secure-id',
      corrId: 'corr-secure',
    } as unknown as FameEnvelope;

    await emitDeliveryNack(
      secureEnvelope,
      router as unknown as any,
      state,
      'HANDSHAKE_FAIL'
    );

    expect(state.envelopeFactory?.createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining({ type: 'SecureAccept', ok: false }),
      })
    );
  });
});

describe('router utility functions', () => {
  it('normalizes route sources from maps and records', () => {
    const addressObj: FameAddress = {
      toString: () => 'addr-object',
    } as unknown as FameAddress;

    const mapState = new RouterState({
      nodeId: 'node-m',
      local: [],
      downstreamAddressRoutes: new Map([[addressObj, 'segment-map']]),
      peerAddressRoutes: {},
      childSegments: [],
      peerSegments: [],
      hasParent: false,
      physicalSegments: ['node-m'],
      pools: new Map(),
      capabilities: {},
      envelopeFactory: {
        createEnvelope: jest.fn((config) => ({ id: 'id', ...config })),
      } as unknown as EnvelopeFactory,
    });
    expect(mapState.downstreamAddressRoutes.get('addr-object')).toBe(
      'segment-map'
    );

    const recordState = new RouterState({
      nodeId: 'node-r',
      local: ['svc@/node-r/local'],
      downstreamAddressRoutes: { 'svc@/node-r/local': 'segment-record' },
      peerAddressRoutes: {},
      childSegments: [],
      peerSegments: [],
      hasParent: false,
      physicalSegments: ['node-r'],
      pools: { 'pool::pattern': new Set(['entry']) },
      capabilities: {},
      envelopeFactory: {
        createEnvelope: jest.fn((config) => ({ id: 'id', ...config })),
      } as unknown as EnvelopeFactory,
    });

    expect(recordState.downstreamAddressRoutes.get('svc@/node-r/local')).toBe(
      'segment-record'
    );
    const [poolKey] = Array.from(recordState.pools.keys());
    expect(poolKey).toEqual(['pool', 'pattern']);
    expect(recordState.pools.get(poolKey)?.has('entry')).toBe(true);
  });

  it('RouterState nextHop resolves first segment after stripping self prefix', () => {
    const state = createState();
    expect(state.nextHop('/node-1/child-a/next')).toBe('child-a');
    expect(state.nextHop('/external/path')).toBe('external');
    expect(state.nextHop('/node-1')).toBe(null);
  });
});
