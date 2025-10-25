import {
  DeliveryOriginType,
  FameAddress,
  FameResponseType,
  type FameDeliveryContext,
  type FameEnvelope,
} from '@naylence/core';

import { DefaultSecurityManager } from '../default-security-manager.js';
import type { NodeLike } from '../../node/node-like.js';
import type { SecurityPolicy } from '../policy/security-policy.js';
import type { KeyManager } from '../keys/key-manager.js';
import type { EnvelopeSigner } from '../signing/envelope-signer.js';

type MockLogger = {
  debug: jest.Mock;
  error: jest.Mock;
  warning: jest.Mock;
};

type ManagerInternals = {
  _keyManagementHandler: {
    acceptKeyAnnounce(
      envelope: FameEnvelope,
      context: FameDeliveryContext
    ): Promise<void>;
  } | null;
  _getKeyAnnounceHandler(): (
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ) => Promise<void>;
  _getKeysToProvide(): Array<Record<string, unknown>> | null;
  handleChildKeyRequest(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<void>;
  getSpawner(
    target: unknown
  ):
    | ((
        task: () => Promise<void>,
        options?: { name?: string }
      ) => Promise<unknown> | unknown)
    | null;
  isRoutingNode(node: NodeLike): boolean;
};

function createNodeWithOverrides(
  overrides: Record<string, unknown> = {}
): NodeLike {
  return {
    id: 'node-test',
    envelopeFactory: {
      createEnvelope: jest.fn(),
    },
    deliver: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as NodeLike;
}

jest.mock('../../util/logging.js', () => {
  const mockLogger: MockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  };

  return {
    __esModule: true,
    getLogger: () => mockLogger,
    __mockLogger: mockLogger,
  };
});

const { __mockLogger: mockLogger } = jest.requireMock(
  '../../util/logging.js'
) as {
  __mockLogger: MockLogger;
};

describe('DefaultSecurityManager.sendNack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createManager(): DefaultSecurityManager {
    return new DefaultSecurityManager({} as SecurityPolicy);
  }

  function createNode(overrides: Record<string, unknown> = {}): NodeLike {
    return {
      id: 'node-1',
      envelopeFactory: {
        createEnvelope: jest.fn(
          (options) =>
            ({
              id: 'generated-id',
              version: '1.0',
              ts: new Date(),
              frame: options.frame,
              to: options.to,
              traceId: options.traceId,
              corrId: options.corrId,
              replyTo: undefined,
            }) as unknown as FameEnvelope
        ),
      },
      deliver: jest.fn(async () => undefined),
      ...overrides,
    } as unknown as NodeLike;
  }

  function createEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
    return {
      id: 'env-1',
      version: '1.0',
      ts: new Date(),
      frame: { type: 'Data' } as FameEnvelope['frame'],
      replyTo: FameAddress.create('reply@/dest'),
      ...overrides,
    };
  }

  it('skips control frames when sending NACK', async () => {
    const manager = createManager();
    const node = createNode();
    const envelope = createEnvelope({
      frame: { type: 'CreditUpdate' } as FameEnvelope['frame'],
    });

    await (manager as any).sendNack(node, envelope, 'reason');

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'nack_skipped_for_control_frame',
      {
        envp_id: 'env-1',
        frame_type: 'CreditUpdate',
        reason: 'reason',
      }
    );
    expect(node.deliver).not.toHaveBeenCalled();
  });

  it('sends DeliveryAck for normal envelopes', async () => {
    const manager = createManager();
    const node = createNode();
    const envelope = createEnvelope({
      frame: { type: 'Data' } as FameEnvelope['frame'],
      corrId: 'corr-1',
      traceId: 'trace-1',
    });

    await (manager as any).sendNack(node, envelope, 'signature_required');

    expect(node.envelopeFactory.createEnvelope).toHaveBeenCalledWith({
      frame: {
        type: 'DeliveryAck',
        ok: false,
        refId: 'env-1',
        code: 'signature_required',
      },
      to: envelope.replyTo,
      corrId: 'corr-1',
      traceId: 'trace-1',
    });

    expect(node.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining({
          type: 'DeliveryAck',
          ok: false,
        }),
        to: envelope.replyTo,
      }),
      {
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: 'node-1',
        expectedResponseType: FameResponseType.NONE,
      }
    );
  });

  it('logs when reply destination is unavailable', async () => {
    const manager = createManager();
    const node = createNode();
    const envelope = createEnvelope({ replyTo: undefined });

    await (manager as any).sendNack(node, envelope, 'no_route');

    expect(mockLogger.debug).toHaveBeenCalledWith('nack_no_destination', {
      envp_id: 'env-1',
    });
    expect(node.deliver).not.toHaveBeenCalled();
  });
});

describe('DefaultSecurityManager._getKeyAnnounceHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a delegating handler when key management handler exists', async () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    const handler = { acceptKeyAnnounce: jest.fn(async () => undefined) };
    const internals = manager as unknown as ManagerInternals;
    internals._keyManagementHandler = handler;

    const delegate = internals._getKeyAnnounceHandler();

    const envelope = { id: 'env' } as FameEnvelope;
    const context = {
      originType: DeliveryOriginType.LOCAL,
    } as FameDeliveryContext;

    await delegate(envelope, context);

    expect(handler.acceptKeyAnnounce).toHaveBeenCalledWith(envelope, context);
  });

  it('returns a no-op handler when key management handler is absent', async () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    const delegate = (
      manager as unknown as ManagerInternals
    )._getKeyAnnounceHandler();

    await expect(
      delegate({} as FameEnvelope, {} as FameDeliveryContext)
    ).resolves.toBeUndefined();
  });
});

describe('DefaultSecurityManager._getKeysToProvide', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null and logs when no envelope signer is configured', () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);

    const result = (manager as unknown as ManagerInternals)._getKeysToProvide();

    expect(result).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'no_keys_provided_no_crypto_components'
    );
  });

  it('returns null when crypto provider is unavailable', () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    manager.envelopeSigner = {} as EnvelopeSigner;
    const internals = manager as unknown as ManagerInternals & {
      _node?: NodeLike | null;
    };
    internals._node = createNodeWithOverrides({ cryptoProvider: null });

    expect(internals._getKeysToProvide()).toBeNull();
  });

  it('includes node and auxiliary JWKs, skipping duplicates', () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    manager.envelopeSigner = {} as EnvelopeSigner;
    const nodeJwk = { kid: 'node-1', use: 'sig', alg: 'EdDSA' };
    const duplicate = { kid: 'node-1', use: 'sig' };
    const encryptionVariant = { kid: 'node-1', use: 'enc', alg: 'X25519' };
    const extra = { kid: 'other', use: 'sig', alg: 'RS256' };

    const internals = manager as unknown as ManagerInternals & {
      _node?: NodeLike | null;
    };
    internals._node = createNodeWithOverrides({
      cryptoProvider: {
        nodeJwk: () => nodeJwk,
        getJwks: () => ({
          keys: [duplicate, encryptionVariant, extra],
        }),
      },
    });

    const keys = internals._getKeysToProvide();

    expect(keys).toEqual([nodeJwk, encryptionVariant, extra]);
  });

  it('returns null when crypto provider retrieval throws', () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    manager.envelopeSigner = {} as EnvelopeSigner;
    const internals = manager as unknown as ManagerInternals & {
      _node?: NodeLike | null;
    };
    internals._node = createNodeWithOverrides({
      cryptoProvider: {
        nodeJwk: () => ({ kid: 'node-1', use: 'sig', alg: 'EdDSA' }),
        getJwks: () => {
          throw new Error('crypto unavailable');
        },
      },
    });

    expect(internals._getKeysToProvide()).toBeNull();
  });
});

describe('DefaultSecurityManager.handleChildKeyRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createManagerWithKeyHandler(
    handleKeyRequest = jest.fn(),
    cryptoProvider: unknown = null
  ): DefaultSecurityManager {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    manager.keyManager = {
      handleKeyRequest,
    } as unknown as KeyManager;
    const internals = manager as unknown as ManagerInternals & {
      _node?: NodeLike | null;
    };
    internals._node = createNodeWithOverrides({ cryptoProvider });
    return manager;
  }

  it('throws when key manager is missing', async () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    const envelope = {
      id: 'env',
      frame: { type: 'KeyRequest', kid: 'kid' },
    } as unknown as FameEnvelope;

    await expect(
      (manager as unknown as ManagerInternals).handleChildKeyRequest(envelope, {
        fromSystemId: 'sid-1',
        originType: DeliveryOriginType.LOCAL,
      } as FameDeliveryContext)
    ).rejects.toThrow('KeyManager must be set for KeyRequest handling');
  });

  it('warns and returns when origin sid is missing', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest);
    const envelope = {
      id: 'env-no-origin',
      frame: { type: 'KeyRequest', kid: 'kid' },
    } as unknown as FameEnvelope;

    await (manager as unknown as ManagerInternals).handleChildKeyRequest(
      envelope,
      {
        fromSystemId: undefined,
      } as FameDeliveryContext
    );

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'missing_origin_sid_for_key_request',
      {
        envp_id: 'env-no-origin',
      }
    );
    expect(handleKeyRequest).not.toHaveBeenCalled();
  });

  it('logs forwarding details when explicit key id is requested', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest);
    const envelope = {
      id: 'env-kid',
      frame: { type: 'KeyRequest', kid: 'key-123' },
      corrId: 'corr-42',
    } as unknown as FameEnvelope;

    await (manager as any).handleChildKeyRequest(envelope, {
      fromSystemId: 'sid-1',
      originType: DeliveryOriginType.PEER,
    });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'handling_key_request_for_child_node',
      expect.objectContaining({
        kid: 'key-123',
        origin_sid: 'sid-1',
        corr_id: 'corr-42',
      })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'child_node_forwarding_key_request',
      expect.objectContaining({
        kid: 'key-123',
        origin_sid: 'sid-1',
        correlation_id: 'corr-42',
      })
    );
    expect(handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'key-123' })
    );
  });

  it('forwards key request with physical path and client sid metadata', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest);
    const envelope = {
      id: 'env-kid-extended',
      frame: { type: 'KeyRequest', kid: 'key-123', physicalPath: 'segment-1' },
      corrId: 'corr-88',
      sid: 'client-7',
    } as unknown as FameEnvelope;

    await (manager as unknown as ManagerInternals).handleChildKeyRequest(
      envelope,
      {
        fromSystemId: 'sid-extended',
        originType: DeliveryOriginType.LOCAL,
      } as FameDeliveryContext
    );

    expect(handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'key-123',
        physicalPath: 'segment-1',
        correlationId: 'corr-88',
        originalClientSid: 'client-7',
      })
    );
  });

  it('logs when responding with local encryption key id', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest, {
      encryptionKeyId: 'enc-key-1',
      signatureKeyId: 'sig-key-1',
    });
    const envelope = {
      id: 'env-address',
      frame: { type: 'KeyRequest', address: FameAddress.create('svc@/path') },
      corrId: 'corr-7',
      sid: 'client-9',
    } as unknown as FameEnvelope;

    await (manager as any).handleChildKeyRequest(envelope, {
      fromSystemId: 'sid-2',
      originType: DeliveryOriginType.LOCAL,
    });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'child_node_responding_with_own_encryption_key_id',
      expect.objectContaining({
        key_id: 'enc-key-1',
        requested_address: 'svc@/path',
        envp_id: 'env-address',
      })
    );
    expect(handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'enc-key-1',
        correlationId: 'corr-7',
        originalClientSid: 'client-9',
      })
    );
  });

  it('logs when responding with local signature key id if encryption key missing', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest, {
      signatureKeyId: 'sig-key-only',
    });
    const envelope = {
      id: 'env-address',
      frame: { type: 'KeyRequest', address: FameAddress.create('svc@/path') },
      corrId: 'corr-sig',
      sid: 'client-sig',
    } as unknown as FameEnvelope;

    await (manager as any).handleChildKeyRequest(envelope, {
      fromSystemId: 'sid-2',
      originType: DeliveryOriginType.LOCAL,
    });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'child_node_responding_with_own_signature_key_id',
      expect.objectContaining({
        key_id: 'sig-key-only',
        requested_address: 'svc@/path',
        envp_id: 'env-address',
      })
    );
    expect(handleKeyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kid: 'sig-key-only',
        correlationId: 'corr-sig',
        originalClientSid: 'client-sig',
      })
    );
  });

  it('logs lookup failure when crypto provider throws', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest, {
      get signatureKeyId() {
        throw new Error('boom');
      },
    });
    const envelope = {
      id: 'env-failure',
      frame: { type: 'KeyRequest', address: FameAddress.create('svc@/path') },
    } as unknown as FameEnvelope;

    await (manager as unknown as ManagerInternals).handleChildKeyRequest(
      envelope,
      {
        fromSystemId: 'sid-2',
        originType: DeliveryOriginType.PEER,
      } as FameDeliveryContext
    );

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'crypto_provider_key_lookup_failed',
      expect.objectContaining({
        error: 'boom',
        envp_id: 'env-failure',
      })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'child_node_cannot_resolve_address_key_request',
      expect.objectContaining({
        address: expect.anything(),
        envp_id: 'env-failure',
      })
    );
    expect(handleKeyRequest).not.toHaveBeenCalled();
  });

  it('warns when key request lacks both kid and address', async () => {
    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest);
    const envelope = {
      id: 'env-empty',
      frame: { type: 'KeyRequest' },
    } as unknown as FameEnvelope;

    await (manager as unknown as ManagerInternals).handleChildKeyRequest(
      envelope,
      {
        fromSystemId: 'sid-3',
        originType: DeliveryOriginType.PEER,
      } as FameDeliveryContext
    );

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'key_request_missing_both_kid_and_address',
      {
        envp_id: 'env-empty',
      }
    );
    expect(handleKeyRequest).not.toHaveBeenCalled();
  });
});

describe('DefaultSecurityManager.getSpawner', () => {
  it('returns a bound spawn function when callable', async () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    const internals = manager as unknown as ManagerInternals;

    let capturedThis: unknown = null;
    const target = {
      spawn: function (this: { marker: string }, task: () => Promise<void>) {
        capturedThis = this;
        return task();
      },
      marker: 'target',
    };

    const delegate = internals.getSpawner(target);
    expect(delegate).toBeInstanceOf(Function);
    expect(delegate).not.toBeNull();

    let ran = false;
    await delegate!(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(capturedThis).toBe(target);
  });

  it('returns null when spawn method is absent', () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    const internals = manager as unknown as ManagerInternals;

    expect(internals.getSpawner({})).toBeNull();
  });
});

describe('DefaultSecurityManager.isRoutingNode', () => {
  it('detects routing nodes by forwardToRoute method', () => {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    const internals = manager as unknown as ManagerInternals;

    const routingNode = { forwardToRoute: jest.fn() } as unknown as NodeLike;
    const plainNode = {} as NodeLike;

    expect(internals.isRoutingNode(routingNode)).toBe(true);
    expect(internals.isRoutingNode(plainNode)).toBe(false);
  });
});
