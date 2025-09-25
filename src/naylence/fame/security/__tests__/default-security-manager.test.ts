import {
  DeliveryOriginType,
  FameAddress,
  FameResponseType,
  type FameEnvelope,
} from 'naylence-core';

import { DefaultSecurityManager } from '../default-security-manager.js';
import type { NodeLike } from '../../node/node-like.js';
import type { SecurityPolicy } from '../policy/security-policy.js';
import { getCryptoProvider } from '../crypto/providers/crypto-provider.js';
import type { KeyManager } from '../keys/key-manager.js';

type MockLogger = {
  debug: jest.Mock;
  error: jest.Mock;
  warning: jest.Mock;
};

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

const { __mockLogger: mockLogger } = jest.requireMock('../../util/logging.js') as {
  __mockLogger: MockLogger;
};

jest.mock('../crypto/providers/crypto-provider.js', () => ({
  __esModule: true,
  getCryptoProvider: jest.fn(),
}));

describe('DefaultSecurityManager.sendNack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createManager(): DefaultSecurityManager {
    return new DefaultSecurityManager({} as SecurityPolicy);
  }

  function createNode(): NodeLike {
    return {
      id: 'node-1',
      envelopeFactory: {
        createEnvelope: jest.fn((options) => ({
          id: 'generated-id',
          version: '1.0',
          ts: new Date(),
          frame: options.frame,
          to: options.to,
          traceId: options.traceId,
          corrId: options.corrId,
          replyTo: undefined,
        }) as unknown as FameEnvelope),
      },
      deliver: jest.fn(async () => undefined),
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

    expect(mockLogger.debug).toHaveBeenCalledWith('nack_skipped_for_control_frame', {
      envp_id: 'env-1',
      frame_type: 'CreditUpdate',
      reason: 'reason',
    });
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

    expect(node.deliver).toHaveBeenCalledWith(expect.objectContaining({
      frame: expect.objectContaining({
        type: 'DeliveryAck',
        ok: false,
      }),
      to: envelope.replyTo,
    }), {
      originType: DeliveryOriginType.LOCAL,
      fromSystemId: 'node-1',
      expectedResponseType: FameResponseType.NONE,
    });
  });
});

describe('DefaultSecurityManager.handleChildKeyRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCryptoProvider as jest.Mock).mockReset();
  });

  function createManagerWithKeyHandler(handleKeyRequest = jest.fn()): DefaultSecurityManager {
    const manager = new DefaultSecurityManager({} as SecurityPolicy);
    manager.keyManager = {
      handleKeyRequest,
    } as unknown as KeyManager;
    return manager;
  }

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

    expect(mockLogger.debug).toHaveBeenCalledWith('handling_key_request_for_child_node', expect.objectContaining({
      kid: 'key-123',
      origin_sid: 'sid-1',
      corr_id: 'corr-42',
    }));
    expect(mockLogger.debug).toHaveBeenCalledWith('child_node_forwarding_key_request', expect.objectContaining({
      kid: 'key-123',
      origin_sid: 'sid-1',
      correlation_id: 'corr-42',
    }));
    expect(handleKeyRequest).toHaveBeenCalledWith(expect.objectContaining({ kid: 'key-123' }));
  });

  it('logs when responding with local encryption key id', async () => {
    (getCryptoProvider as jest.Mock).mockReturnValue({
      encryptionKeyId: 'enc-key-1',
      signatureKeyId: 'sig-key-1',
    });

    const handleKeyRequest = jest.fn(async () => undefined);
    const manager = createManagerWithKeyHandler(handleKeyRequest);
    const envelope = {
      id: 'env-address',
      frame: { type: 'KeyRequest', address: FameAddress.create('svc@/path') },
      corrId: 'corr-7',
    } as unknown as FameEnvelope;

    await (manager as any).handleChildKeyRequest(envelope, {
      fromSystemId: 'sid-2',
      originType: DeliveryOriginType.LOCAL,
    });

    expect(mockLogger.debug).toHaveBeenCalledWith('child_node_responding_with_own_encryption_key_id', expect.objectContaining({
      key_id: 'enc-key-1',
      requested_address: 'svc@/path',
      envp_id: 'env-address',
    }));
    expect(handleKeyRequest).toHaveBeenCalledWith(expect.objectContaining({ kid: 'enc-key-1' }));
  });
});
