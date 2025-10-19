import {
  DeliveryOriginType,
  type EnvelopeFactory,
  type FameEnvelope,
} from 'naylence-core';

import { secureDigest } from '../../../util/util.js';
import * as jwkValidation from '../../crypto/jwk-validation.js';
import type { NodeLike } from '../../../node/node-like.js';
import type { RoutingNodeLike } from '../../../node/routing-node-like.js';
import { DefaultKeyManager } from '../default-key-manager.js';
import type { KeyRecord, KeyStore } from '../key-store.js';

function createValidSigningKey(kid: string): Record<string, unknown> {
  return {
    kid,
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'abc',
    use: 'sig',
  };
}

function createValidEncryptionKey(
  kid: string,
  physicalPath: string
): KeyRecord {
  return {
    kid,
    kty: 'OKP',
    crv: 'X25519',
    x: 'def',
    use: 'enc',
    physical_path: physicalPath,
  } as KeyRecord;
}

function createMockKeyStore() {
  const mocks = {
    addKeys: jest.fn(async () => {}),
    addKey: jest.fn(async () => {}),
    getKey: jest.fn(async (_kid: string): Promise<KeyRecord> => {
      throw new Error('not found');
    }),
    hasKey: jest.fn(async () => false),
    getKeys: jest.fn(async () => []),
    getKeysForPath: jest.fn(async () => [] as KeyRecord[]),
    getKeysGroupedByPath: jest.fn(
      async () => ({}) as Record<string, KeyRecord[]>
    ),
    removeKeysForPath: jest.fn(async () => 0),
    removeKey: jest.fn(async () => false),
  };
  return { store: mocks as unknown as KeyStore, mocks };
}

function createEnvelopeFactory() {
  const createEnvelope = jest.fn(() => ({}) as FameEnvelope);
  return { factory: { createEnvelope } as EnvelopeFactory, createEnvelope };
}

function createMockNode(options?: {
  hasParent?: boolean;
  physicalPath?: string;
  includeRouting?: boolean;
  forwardToPeersMock?: jest.Mock;
  forwardToRouteMock?: jest.Mock;
}) {
  const { factory, createEnvelope } = createEnvelopeFactory();

  const forwardUpstream = jest.fn(async () => {});
  const includeRouting = options?.includeRouting ?? true;
  const forwardToPeers = includeRouting
    ? (options?.forwardToPeersMock ?? jest.fn(async () => {}))
    : undefined;
  const forwardToRoute = includeRouting
    ? (options?.forwardToRouteMock ?? jest.fn(async () => {}))
    : undefined;

  const nodeBase: Record<string, unknown> = {
    id: 'node-1',
    sid: 'node-sid',
    physicalPath: options?.physicalPath ?? '/parent/node',
    hasParent: options?.hasParent ?? true,
    envelopeFactory: factory,
    forwardUpstream,
  };

  if (includeRouting) {
    nodeBase.forwardToPeers = forwardToPeers;
    nodeBase.forwardToRoute = forwardToRoute;
    nodeBase.createOriginConnector = jest.fn();
  }

  const node = nodeBase as unknown as NodeLike & Partial<RoutingNodeLike>;

  return {
    node,
    envelopeFactory: createEnvelope,
    forwardUpstream,
    forwardToPeers,
    forwardToRoute,
  };
}

describe('DefaultKeyManager', () => {
  it('starts and stops node without errors', async () => {
    const { store } = createMockKeyStore();
    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });

    await manager.onNodeStarted(node);
    await manager.onNodeStopped(node);
  });

  it('forwards getKey requests to underlying store', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecord = createValidSigningKey('kid-fetch') as KeyRecord;
    mocks.getKey.mockImplementationOnce(async () => keyRecord);
    const manager = new DefaultKeyManager({ keyStore: store });

    const result = await manager.getKey('kid-fetch');

    expect(result).toBe(keyRecord);
    expect(mocks.getKey).toHaveBeenCalledWith('kid-fetch');
  });

  it('forwards hasKey checks to underlying store', async () => {
    const { store, mocks } = createMockKeyStore();
    mocks.hasKey.mockImplementationOnce(async () => true);
    const manager = new DefaultKeyManager({ keyStore: store });

    const result = await manager.hasKey('kid-check');

    expect(result).toBe(true);
    expect(mocks.hasKey).toHaveBeenCalledWith('kid-check');
  });

  it('adds valid keys locally', async () => {
    const { store, mocks } = createMockKeyStore();
    const manager = new DefaultKeyManager({ keyStore: store });

    await manager.addKeys({
      keys: [createValidSigningKey('kid-1')],
      physicalPath: '/systems/a',
      systemId: 'a',
      origin: DeliveryOriginType.LOCAL,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
    expect(mocks.addKeys).toHaveBeenCalledWith(expect.any(Array), '/systems/a');
  });

  it('throws when announcing without envelope factory', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    Object.defineProperty(
      helper.node as unknown as Record<string, unknown>,
      'envelopeFactory',
      {
        value: null,
      }
    );

    const sid = secureDigest('/parent/node/child');

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-uninitialized')],
        physicalPath: '/parent/node/child',
        systemId: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
        sid,
      })
    ).rejects.toThrow('Envelope factory not available');

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('skips storing when all keys are invalid', async () => {
    const { store, mocks } = createMockKeyStore();
    const manager = new DefaultKeyManager({ keyStore: store });

    await manager.addKeys({
      keys: [{ kid: 'broken' }],
      physicalPath: '/systems/a',
      systemId: 'a',
      origin: DeliveryOriginType.LOCAL,
    });

    expect(mocks.addKeys).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors during key validation', async () => {
    const { store } = createMockKeyStore();
    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const validationSpy = jest
      .spyOn(jwkValidation, 'validateJwkComplete')
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-boom')],
        physicalPath: '/parent/node/child',
        systemId: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
        sid: secureDigest('/parent/node/child'),
      })
    ).rejects.toThrow('boom');

    expect(validationSpy).toHaveBeenCalled();
    validationSpy.mockRestore();
  });

  it('rejects downstream announcements with mismatched sid', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-2')],
        physicalPath: '/parent/node/child',
        systemId: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
        sid: 'invalid',
      })
    ).rejects.toThrow('Invalid downstream sid');

    expect(mocks.addKeys).not.toHaveBeenCalled();
  });

  it('announces downstream keys upstream and to peers when sid matches', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node, envelopeFactory, forwardUpstream, forwardToPeers } =
      createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const sid = secureDigest('/parent/node/child');

    await manager.addKeys({
      keys: [createValidSigningKey('kid-3')],
      physicalPath: '/parent/node/child',
      systemId: 'child',
      origin: DeliveryOriginType.DOWNSTREAM,
      sid,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
    expect(forwardUpstream).toHaveBeenCalledTimes(1);
    expect(forwardToPeers).toHaveBeenCalledTimes(1);

    expect(envelopeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining({ type: 'KeyAnnounce' }),
      })
    );
  });

  it('throws when announcing downstream keys without node id for upstream forwarding', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode();
    Object.defineProperty(
      helper.node as unknown as Record<string, unknown>,
      'id',
      {
        value: '',
      }
    );
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    const sid = secureDigest('/parent/node/child');

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-missing-node')],
        physicalPath: '/parent/node/child',
        systemId: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
        sid,
      })
    ).rejects.toThrow('Node ID not available');

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('processes upstream key announcements without reannounce', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node, forwardUpstream, forwardToPeers } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const sid = secureDigest('/parent');

    await manager.addKeys({
      keys: [createValidSigningKey('kid-up')],
      physicalPath: '/parent',
      systemId: 'parent',
      origin: DeliveryOriginType.UPSTREAM,
      sid,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
    expect(forwardUpstream).not.toHaveBeenCalled();
    expect(forwardToPeers).not.toHaveBeenCalled();
  });

  it('stores downstream child path without leading slash', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode({ physicalPath: '/', hasParent: true });
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    const sid = secureDigest('/child');

    await manager.addKeys({
      keys: [createValidSigningKey('kid-child-path')],
      physicalPath: 'child',
      systemId: 'child',
      origin: DeliveryOriginType.DOWNSTREAM,
      sid,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('accepts upstream sid when node path is root', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node } = createMockNode({ physicalPath: '/', hasParent: true });
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const sid = secureDigest('/');

    await manager.addKeys({
      keys: [createValidSigningKey('kid-root')],
      physicalPath: '/',
      systemId: '',
      origin: DeliveryOriginType.UPSTREAM,
      sid,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('allows skipping sid validation when requested', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await manager.addKeys({
      keys: [createValidSigningKey('kid-skip')],
      physicalPath: '/parent/node/child',
      systemId: 'child',
      origin: DeliveryOriginType.DOWNSTREAM,
      sid: 'incorrect',
      skipSidValidation: true,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('stores downstream path when physical path empty at root', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode({
      physicalPath: '/',
      hasParent: false,
      includeRouting: false,
    });
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    await manager.addKeys({
      keys: [createValidSigningKey('kid-empty-path')],
      physicalPath: '',
      systemId: '',
      origin: DeliveryOriginType.DOWNSTREAM,
      skipSidValidation: true,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('throws when sid provided for unknown origin', async () => {
    const { store } = createMockKeyStore();
    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-unknown')],
        physicalPath: '/parent/node/child',
        systemId: 'child',
        origin: 'mystery' as DeliveryOriginType,
        sid: 'unexpected-sid',
      })
    ).rejects.toThrow('Unable to determine expected SID');
  });

  it('stores peer keys with valid sid', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    const sid = secureDigest('/peer-node');

    await manager.addKeys({
      keys: [createValidSigningKey('kid-peer')],
      physicalPath: '/peer-node',
      systemId: 'peer-node',
      origin: DeliveryOriginType.PEER,
      sid,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('throws when downstream physical path does not match expected prefix', async () => {
    const { store } = createMockKeyStore();
    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const sid = secureDigest('/parent/node/child');

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-mismatch')],
        physicalPath: '/other/path',
        systemId: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
        sid,
      })
    ).rejects.toThrow('Frame physical path');
  });

  it('skips announcing when node lacks upstream and routing destinations', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node, forwardUpstream } = createMockNode({
      hasParent: false,
      physicalPath: '/edge',
      includeRouting: false,
    });
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const sid = secureDigest('/edge/child');

    await manager.addKeys({
      keys: [createValidSigningKey('kid-edge')],
      physicalPath: '/edge/child',
      systemId: 'child',
      origin: DeliveryOriginType.DOWNSTREAM,
      sid,
    });

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
    expect(forwardUpstream).not.toHaveBeenCalled();
  });

  it('handles key request using fallback path and routes downstream', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecord = createValidEncryptionKey('kid-4', '/parent/node/child');
    mocks.getKey.mockRejectedValueOnce(new Error('missing'));
    mocks.getKeysForPath.mockResolvedValueOnce([keyRecord]);

    const { node, envelopeFactory, forwardToRoute, forwardUpstream } =
      createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await manager.handleKeyRequest({
      kid: 'kid-4',
      fromSegment: 'child',
      physicalPath: '/parent/node/child',
      origin: DeliveryOriginType.DOWNSTREAM,
      correlationId: 'corr-1',
      originalClientSid: 'client-sid',
    });

    expect(envelopeFactory).toHaveBeenCalledWith({
      frame: expect.objectContaining({
        type: 'KeyAnnounce',
        physicalPath: '/parent/node/child',
      }),
      corrId: 'corr-1',
    });
    expect(forwardToRoute).toHaveBeenCalledTimes(1);
    expect(forwardUpstream).not.toHaveBeenCalled();
  });

  it('throws when fallback keys are unavailable', async () => {
    const { store, mocks } = createMockKeyStore();
    mocks.getKey.mockRejectedValueOnce(new Error('missing'));
    mocks.getKeysForPath.mockResolvedValueOnce([]);

    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await expect(
      manager.handleKeyRequest({
        kid: 'kid-missing',
        fromSegment: 'child',
        physicalPath: '/parent/node/child',
        origin: DeliveryOriginType.DOWNSTREAM,
      })
    ).rejects.toThrow('missing');

    expect(mocks.getKeysForPath).toHaveBeenCalledWith('/parent/node/child');
  });

  it('throws when key request lacks physical path and key is missing', async () => {
    const { store, mocks } = createMockKeyStore();
    mocks.getKey.mockRejectedValueOnce(new Error('missing'));

    const { node } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await expect(
      manager.handleKeyRequest({
        kid: 'kid-miss',
        fromSegment: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
      })
    ).rejects.toThrow('missing');

    expect(mocks.getKeysForPath).not.toHaveBeenCalled();
  });

  it('forwards upstream key request when key is available locally', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecord = {
      kid: 'kid-6',
      use: 'sig',
      physical_path: '/parent/node',
    } as KeyRecord;
    mocks.getKey.mockImplementationOnce(async () => keyRecord);

    const { node, forwardUpstream } = createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await manager.handleKeyRequest({
      kid: 'kid-6',
      fromSegment: 'parent',
      origin: DeliveryOriginType.UPSTREAM,
    });

    expect(forwardUpstream).toHaveBeenCalledTimes(1);
    expect(mocks.getKeysForPath).not.toHaveBeenCalled();
  });

  it('throws when key request processed without node id', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecord = {
      kid: 'kid-nodeless',
      use: 'sig',
      physical_path: '/parent/node',
    } as KeyRecord;
    mocks.getKey.mockImplementationOnce(async () => keyRecord);

    const helper = createMockNode();
    Object.defineProperty(
      helper.node as unknown as Record<string, unknown>,
      'id',
      {
        value: '',
      }
    );
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    await expect(
      manager.handleKeyRequest({
        kid: 'kid-nodeless',
        fromSegment: 'parent',
        origin: DeliveryOriginType.UPSTREAM,
      })
    ).rejects.toThrow('Node ID not available');

    expect(mocks.getKeysForPath).not.toHaveBeenCalled();
  });

  it('throws when downstream key request lacks routing node', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecord = {
      kid: 'kid-downstream',
      use: 'enc',
      physical_path: '/parent/node/child',
    } as KeyRecord;
    mocks.getKey.mockImplementationOnce(async () => keyRecord);

    const helper = createMockNode({ includeRouting: false });
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    await expect(
      manager.handleKeyRequest({
        kid: 'kid-downstream',
        fromSegment: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
      })
    ).rejects.toThrow('Forward downstream not available');

    expect(mocks.getKeysForPath).not.toHaveBeenCalled();
  });

  it('throws when routing node lacks forwardToRoute implementation', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecord = createValidSigningKey('kid-7') as KeyRecord;
    mocks.getKey.mockImplementationOnce(async () => keyRecord);

    const helper = createMockNode();
    delete (helper.node as any).forwardToRoute;

    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    await expect(
      manager.handleKeyRequest({
        kid: 'kid-7',
        fromSegment: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
      })
    ).rejects.toThrow('Routing node does not support forwardToRoute');
  });

  it('returns early when announcing keys without upstream', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node } = createMockNode({
      hasParent: false,
      includeRouting: false,
    });
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    await manager.announceKeysToUpstream();

    expect(mocks.getKeysGroupedByPath).not.toHaveBeenCalled();
  });

  it('announces stored keys upstream on demand', async () => {
    const { store, mocks } = createMockKeyStore();
    const { node, forwardUpstream, forwardToPeers, envelopeFactory } =
      createMockNode();
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(node);

    const storedKey: KeyRecord = {
      kid: 'kid-5',
      use: 'sig',
      physical_path: '/parent/node/child',
    } as KeyRecord;
    mocks.getKeysGroupedByPath.mockResolvedValueOnce({
      '/parent/node/child': [storedKey],
      '/other': [storedKey],
    });

    await manager.announceKeysToUpstream();

    expect(envelopeFactory).toHaveBeenCalledWith({
      frame: expect.objectContaining({
        type: 'KeyAnnounce',
        physicalPath: '/parent/node/child',
      }),
    });
    expect(forwardUpstream).toHaveBeenCalledTimes(1);
    expect(forwardToPeers).toHaveBeenCalledTimes(1);
  });

  it('handles reannounce failures when forwarding upstream', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode();
    Object.defineProperty(
      helper.node as unknown as Record<string, unknown>,
      'id',
      {
        value: '',
      }
    );
    const manager = new DefaultKeyManager({ keyStore: store });

    const storedKey: KeyRecord = {
      kid: 'kid-reannounce',
      use: 'sig',
      physical_path: '/parent/node/child',
    } as KeyRecord;
    // Mock for both auto-announce in onNodeStarted and the explicit test call
    mocks.getKeysGroupedByPath.mockResolvedValue({
      '/parent/node/child': [storedKey],
    });

    await manager.onNodeStarted(helper.node);
    await manager.announceKeysToUpstream();

    expect(mocks.getKeysGroupedByPath).toHaveBeenCalledTimes(2);
  });

  it('throws when routing peer forwarding lacks node id', async () => {
    const { store, mocks } = createMockKeyStore();
    const helper = createMockNode({ hasParent: false });
    Object.defineProperty(
      helper.node as unknown as Record<string, unknown>,
      'id',
      {
        value: '',
      }
    );
    const manager = new DefaultKeyManager({ keyStore: store });
    await manager.onNodeStarted(helper.node);

    // Set up a routing node so that announcePathKeys will attempt to forward to peers
    manager.routingNode = {
      forwardToPeers: jest.fn(),
    } as unknown as RoutingNodeLike;

    const sid = secureDigest('/parent/node/child');

    await expect(
      manager.addKeys({
        keys: [createValidSigningKey('kid-missing-route')],
        physicalPath: '/parent/node/child',
        systemId: 'child',
        origin: DeliveryOriginType.DOWNSTREAM,
        sid,
      })
    ).rejects.toThrow('Node ID not available');

    expect(mocks.addKeys).toHaveBeenCalledTimes(1);
  });

  it('removes keys for path and returns count', async () => {
    const { store, mocks } = createMockKeyStore();
    mocks.removeKeysForPath.mockResolvedValueOnce(3);
    const manager = new DefaultKeyManager({ keyStore: store });

    const removed = await manager.removeKeysForPath('/systems/a');

    expect(removed).toBe(3);
    expect(mocks.removeKeysForPath).toHaveBeenCalledWith('/systems/a');
  });

  it('returns keys for path via key store', async () => {
    const { store, mocks } = createMockKeyStore();
    const keyRecords = [createValidSigningKey('kid-lookup') as KeyRecord];
    mocks.getKeysForPath.mockResolvedValueOnce(keyRecords);
    const manager = new DefaultKeyManager({ keyStore: store });

    const result = await manager.getKeysForPath('/systems/a');

    expect(result).toBe(keyRecords);
    expect(mocks.getKeysForPath).toHaveBeenCalledWith('/systems/a');
  });
});
