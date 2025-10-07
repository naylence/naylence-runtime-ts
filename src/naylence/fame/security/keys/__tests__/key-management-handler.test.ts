import {
  DeliveryOriginType,
  FameAddress,
  type CreateFameEnvelopeOptions,
  type FameDeliveryContext,
  type FameEnvelope,
  type KeyAnnounceFrame,
  type KeyRequestFrame,
} from 'naylence-core';

import { KeyManagementHandler } from '../key-management-handler.js';
import { KeyValidationError } from '../attachment-key-validator.js';
import type { AttachmentKeyValidator } from '../attachment-key-validator.js';
import type { KeyManager } from '../key-manager.js';
import type { EncryptionManager } from '../../encryption/encryption-manager.js';
import type { NodeLike } from '../../../node/node-like.js';
import * as envelopeContextModule from '../../../util/envelope-context.js';
import * as taskUtilsModule from '../../../util/task-utils.js';
import type { CryptoProvider } from '../../crypto/providers/crypto-provider.js';

type MockLogger = {
  debug: jest.Mock;
  warning: jest.Mock;
  error: jest.Mock;
};

jest.mock('../../../util/logging.js', () => {
  const mockLogger: MockLogger = {
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  };

  return {
    __esModule: true,
    getLogger: () => mockLogger,
    __mockLogger: mockLogger,
  };
});

const { __mockLogger: mockLogger } = jest.requireMock(
  '../../../util/logging.js'
) as {
  __mockLogger: MockLogger;
};

const currentTraceIdSpy = jest.spyOn(envelopeContextModule, 'currentTraceId');
const delaySpy = jest.spyOn(taskUtilsModule, 'delay');
interface HandlerDeps {
  node?: NodeLike;
  keyManager?: KeyManager | null;
  keyValidator?: AttachmentKeyValidator;
  encryptionManager?: EncryptionManager | null;
}

type MockEncryptionManager = EncryptionManager & {
  notifyKeyAvailable: jest.Mock;
};

const activeHandlers: KeyManagementHandler[] = [];

afterEach(async () => {
  await Promise.all(
    activeHandlers.map((handler) =>
      handler.shutdownTasks({
        gracePeriod: 0,
        cancelHanging: true,
        joinTimeout: 0,
      })
    )
  );
  activeHandlers.length = 0;
  jest.clearAllMocks();
  currentTraceIdSpy.mockReset();
  delaySpy.mockReset();
});

function flushAll(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: (value?: void) => void;
  reject: (reason?: unknown) => void;
  readonly settled: boolean;
} {
  let settled = false;
  let resolve!: (value?: void) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = (value?: void) => {
      if (!settled) {
        settled = true;
        res(value);
      }
    };
    reject = (reason?: unknown) => {
      if (!settled) {
        settled = true;
        rej(reason);
      }
    };
  });

  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

function createMockNode(
  overrides: {
    physicalPath?: string;
    physicalPathDescriptor?: PropertyDescriptor;
    forwardToPeer?: (
      segment: string,
      envelope: FameEnvelope,
      context?: FameDeliveryContext
    ) => Promise<void>;
    cryptoProvider?: CryptoProvider | null;
  } = {}
): NodeLike {
  const envelopeFactory = {
    createEnvelope: jest.fn(
      (options: CreateFameEnvelopeOptions) =>
        ({
          id: options.corrId ?? 'generated-id',
          version: '1.0',
          frame: options.frame,
          corrId: options.corrId,
          traceId: options.traceId,
          ts: new Date(),
          to: undefined,
        }) as FameEnvelope
    ),
  };

  const node: Record<string, unknown> = {
    id: 'node-1',
    sid: 'node-1',
    hasParent: true,
    deliver: jest.fn(async () => undefined),
    forwardUpstream: jest.fn(async () => undefined),
    envelopeFactory,
    cryptoProvider:
      overrides.cryptoProvider ?? (null as unknown as CryptoProvider),
  };

  if (overrides.forwardToPeer) {
    Object.assign(node, {
      forwardToPeer: jest.fn(overrides.forwardToPeer),
    });
  }

  Object.defineProperty(
    node,
    'physicalPath',
    overrides.physicalPathDescriptor ?? {
      configurable: true,
      get: () => overrides.physicalPath ?? '/physical/path',
    }
  );

  return node as unknown as NodeLike;
}

function createHandler(deps: HandlerDeps = {}) {
  const node = deps.node ?? createMockNode();
  const keyManager: KeyManager | null =
    deps.keyManager === null
      ? null
      : (deps.keyManager ??
        ({
          addKeys: jest.fn(async () => undefined),
          hasKey: jest.fn(async () => false),
        } as unknown as KeyManager));
  const keyValidator =
    deps.keyValidator ??
    ({
      validateKey: jest.fn(async (key) => key),
    } as unknown as AttachmentKeyValidator);
  const encryptionManager: MockEncryptionManager | null =
    deps.encryptionManager === null
      ? null
      : deps.encryptionManager
        ? (deps.encryptionManager as MockEncryptionManager)
        : ({
            notifyKeyAvailable: jest.fn(async () => undefined),
          } as unknown as MockEncryptionManager);

  const handler = new KeyManagementHandler({
    node,
    keyManager: keyManager as KeyManager | null,
    keyValidator,
    encryptionManager: encryptionManager as EncryptionManager | null,
  });
  activeHandlers.push(handler);

  return {
    handler,
    node,
    keyManager: keyManager as KeyManager | null,
    keyValidator,
    encryptionManager,
  };
}

function makeKeyAnnounceEnvelope(
  overrides: {
    frame?: Partial<KeyAnnounceFrame>;
    id?: string;
    corrId?: string;
    sid?: string;
  } = {}
): FameEnvelope {
  const baseFrame: KeyAnnounceFrame = {
    type: 'KeyAnnounce',
    keys: [],
    physicalPath: '/origin',
    created: new Date().toISOString(),
  };
  const frame: KeyAnnounceFrame = {
    ...baseFrame,
    ...(overrides.frame ?? {}),
    type: 'KeyAnnounce',
  };

  return {
    id: overrides.id ?? 'env',
    version: '1.0',
    ts: new Date(),
    frame: frame as FameEnvelope['frame'],
    corrId: overrides.corrId,
    sid: overrides.sid,
    replyTo: undefined,
  } as FameEnvelope;
}

function makeEnvelope(frame: FameEnvelope['frame'], id = 'env'): FameEnvelope {
  return {
    id,
    version: '1.0',
    ts: new Date(),
    frame,
    replyTo: undefined,
  } as FameEnvelope;
}

describe('KeyManagementHandler.acceptKeyAnnounce', () => {
  it('ignores envelopes that are not key announcements', async () => {
    const { handler } = createHandler();
    const envelope = makeEnvelope(
      { type: 'Data' } as unknown as FameEnvelope['frame'],
      'env'
    );

    await handler.acceptKeyAnnounce(envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'upstream',
    } as FameDeliveryContext);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'unexpected_frame_type_for_key_announce',
      expect.objectContaining({ envp_id: 'env', frame_type: 'Data' })
    );
  });

  it('skips key announces when no key manager is configured', async () => {
    const { handler } = createHandler({ keyManager: null });
    const envelope = makeKeyAnnounceEnvelope({ id: 'env' });

    await handler.acceptKeyAnnounce(envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'skipping_key_announce_no_key_manager',
      {
        envelope_id: 'env',
      }
    );
  });

  it('throws when delivery context is missing or lacks origin type', async () => {
    const { handler } = createHandler();
    const announce = makeKeyAnnounceEnvelope({ id: 'env' });

    await expect(handler.acceptKeyAnnounce(announce)).rejects.toThrow(
      'KeyAnnounce handling requires delivery context'
    );

    await expect(
      handler.acceptKeyAnnounce(announce, {} as FameDeliveryContext)
    ).rejects.toThrow(
      'Delivery context must include originType for KeyAnnounce'
    );
  });

  it('warns when origin system id is missing', async () => {
    const { handler } = createHandler();
    const announce = makeKeyAnnounceEnvelope({ id: 'env' });

    await handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
    } as FameDeliveryContext);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'key_announce_missing_origin_system_id',
      expect.objectContaining({ envelope_id: 'env' })
    );
  });

  it('returns early when every announced key fails validation', async () => {
    const keyValidator = {
      validateKey: jest.fn(async () => {
        throw new KeyValidationError('invalid', 'bad-key');
      }),
    } as unknown as AttachmentKeyValidator;
    const keyManager = {
      addKeys: jest.fn(),
      hasKey: jest.fn(),
    } as unknown as KeyManager;
    const { handler } = createHandler({ keyValidator, keyManager });
    const announce = makeKeyAnnounceEnvelope({
      id: 'env',
      frame: {
        keys: [{} as Record<string, unknown>],
      },
    });

    await handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'no_valid_keys_remaining_after_certificate_validation',
      expect.objectContaining({ total_keys: 1 })
    );
    expect(keyManager.addKeys).not.toHaveBeenCalled();
  });

  it('adds validated keys, handles correlations, and replays pending envelopes', async () => {
    const keyValidator = {
      validateKey: jest
        .fn()
        .mockImplementationOnce(async (key) => key)
        .mockImplementationOnce(async () => {
          throw new KeyValidationError('invalid', 'bad', { kid: 'bad' });
        }),
    } as unknown as AttachmentKeyValidator;

    const keyManager = {
      addKeys: jest.fn(async () => undefined),
      hasKey: jest.fn(async () => false),
    } as unknown as KeyManager;

    const encryptionManager = {
      notifyKeyAvailable: jest.fn(async () => undefined),
    } as unknown as MockEncryptionManager;

    const result = createHandler({
      keyValidator,
      keyManager,
      encryptionManager,
    });
    const { handler, node } = result;
    const manager = result.encryptionManager as MockEncryptionManager;

    const kid = 'kid-1';
    const address = FameAddress.create('svc@/path');
    const envelope = makeKeyAnnounceEnvelope({
      id: 'announce',
      corrId: 'corr-1',
      sid: 'sid-1',
      frame: {
        keys: [{ kid }, { kid: 'bad' }] as Record<string, unknown>[],
        address,
      },
    });

    handler.queuePendingSignedEnvelope(kid, envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'up',
    } as FameDeliveryContext);

    handler.queuePendingEncryptionEnvelope(kid, envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'up',
    } as FameDeliveryContext);

    handler.queuePendingEncryptionEnvelope(String(address), envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'up',
    } as FameDeliveryContext);

    const deferred = createDeferred();
    (handler as any).pendingEncryptionKeyRequests.set(String(address), {
      deferred,
      origin: DeliveryOriginType.LOCAL,
      fromSystemId: 'local',
      expiresAt: 0,
      retries: 0,
    });

    (handler as any).correlationToAddress.set('corr-1', String(address));

    await handler.acceptKeyAnnounce(envelope, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'source',
    } as FameDeliveryContext);

    await deferred.promise;
    await flushAll();

    expect(keyManager.addKeys).toHaveBeenCalledTimes(2);
    expect(node.deliver).toHaveBeenCalled();
    // NOTE: We no longer notify encryption manager to prevent infinite replay loops.
    // The KeyManagementHandler handles replay directly via pendingEncryptionEnvelopes.
    // expect(manager.notifyKeyAvailable).toHaveBeenCalledWith(kid);
    // expect(manager.notifyKeyAvailable).toHaveBeenCalledWith(`request-${String(address)}`);
    expect(mockLogger.debug).toHaveBeenCalledWith('key_validation_rejections', {
      rejected_count: 1,
      accepted_count: 1,
    });
  });

  it('handles key announces with undefined key arrays', async () => {
    const { handler } = createHandler();
    const announce = makeKeyAnnounceEnvelope({
      id: 'undefined-keys',
    });
    delete (announce.frame as Record<string, unknown>).keys;

    await handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'no_valid_keys_remaining_after_certificate_validation',
      expect.objectContaining({ total_keys: 0 })
    );
  });

  it('rethrows unexpected validation errors', async () => {
    const keyValidator = {
      validateKey: jest.fn(async () => {
        throw new Error('unexpected');
      }),
    } as unknown as AttachmentKeyValidator;
    const { handler } = createHandler({ keyValidator });
    const announce = makeKeyAnnounceEnvelope({
      id: 'unexpected-error',
      frame: {
        keys: [{} as Record<string, unknown>],
      },
    });

    await expect(
      handler.acceptKeyAnnounce(announce, {
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'origin',
      } as FameDeliveryContext)
    ).rejects.toThrow('unexpected');
  });

  it('skips onNewKey when key id is missing', async () => {
    const keyManager = {
      addKeys: jest.fn(async () => undefined),
      hasKey: jest.fn(async () => false),
    } as unknown as KeyManager;
    const handlerSpy = createHandler({ keyManager });
    const onNewKeySpy = jest.spyOn(handlerSpy.handler as any, 'onNewKey');
    const announce = makeKeyAnnounceEnvelope({
      id: 'missing-kid',
      frame: {
        keys: [{} as Record<string, unknown>],
      },
    });

    await handlerSpy.handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    expect(onNewKeySpy).not.toHaveBeenCalled();
  });

  it('propagates sid information when available', async () => {
    const keyManager = {
      addKeys: jest.fn(async () => undefined),
      hasKey: jest.fn(async () => false),
    } as unknown as KeyManager;
    const { handler } = createHandler({ keyManager });
    const announce = makeKeyAnnounceEnvelope({
      id: 'sid-env',
      sid: 'sid-123',
      frame: {
        keys: [{ kid: 'kid-sid' }] as Record<string, unknown>[],
      },
    });

    await handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    expect(keyManager.addKeys).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-123' })
    );
  });

  it('skips correlation handling when original address is unknown', async () => {
    const keyManager = {
      addKeys: jest.fn(async () => undefined),
      hasKey: jest.fn(async () => false),
    } as unknown as KeyManager;
    const { handler } = createHandler({ keyManager });
    const announce = makeKeyAnnounceEnvelope({
      id: 'missing-corr',
      corrId: 'corr-missing',
      frame: {
        keys: [{ kid: 'kid-corr' }] as Record<string, unknown>[],
      },
    });

    await handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    expect((handler as any).correlationToAddress.size).toBe(0);
    expect(keyManager.addKeys).toHaveBeenCalledTimes(1);
  });

  it('propagates sid information for correlation routed announcements', async () => {
    const keyManager = {
      addKeys: jest.fn(async () => undefined),
      hasKey: jest.fn(async () => false),
    } as unknown as KeyManager;
    const { handler } = createHandler({ keyManager });
    (handler as any).correlationToAddress.set('corr-addr', '/logical/path');

    const announce = makeKeyAnnounceEnvelope({
      id: 'corr-with-sid',
      sid: 'sid-corr',
      corrId: 'corr-addr',
      frame: {
        keys: [{ kid: 'kid-corr' }] as Record<string, unknown>[],
      },
    });

    await handler.acceptKeyAnnounce(announce, {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
    } as FameDeliveryContext);

    const addCalls = keyManager.addKeys as jest.Mock;
    expect(addCalls).toHaveBeenCalledTimes(2);
    expect(addCalls.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        sid: 'sid-corr',
        physicalPath: '/logical/path',
        skipSidValidation: true,
      })
    );
  });

  it('replays queued encryption envelopes when a new key arrives', async () => {
    const { handler, node } = createHandler();

    const kid = 'enc-1';
    const envelope = makeEnvelope(
      { type: 'Data' } as FameEnvelope['frame'],
      'pending-env'
    );
    const context = {
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'source-system',
    } as FameDeliveryContext;

    handler.queuePendingEncryptionEnvelope(kid, envelope, context);

    (handler as unknown as { onNewKey: (kid: string) => void }).onNewKey(kid);
    await flushAll();

    expect(node.deliver).toHaveBeenCalledWith(envelope, context);
    expect(
      (
        handler as unknown as {
          pendingEncryptionEnvelopes: Map<string, unknown>;
        }
      ).pendingEncryptionEnvelopes.has(kid)
    ).toBe(false);
  });
});

describe('KeyManagementHandler retry logic', () => {
  it('kicks off retries for queued envelopes after attachment', async () => {
    const { handler } = createHandler();
    const spy = jest
      .spyOn(handler, 'maybeRequestSigningKey')
      .mockResolvedValue(undefined);

    handler.queuePendingSignedEnvelope(
      'kid-queue',
      makeEnvelope({ type: 'Data' } as unknown as FameEnvelope['frame'], 'env'),
      {
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'origin',
      } as FameDeliveryContext
    );

    await handler.retryPendingKeyRequestsAfterAttachment();

    expect(spy).toHaveBeenCalledWith(
      'kid-queue',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
  });

  it('skips retry when a pending request already exists', async () => {
    const { handler } = createHandler();
    (handler as any).pendingKeyRequests.set('kid-existing', {
      deferred: createDeferred(),
      origin: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
      expiresAt: 0,
      retries: 0,
    });

    handler.queuePendingSignedEnvelope(
      'kid-existing',
      makeEnvelope({ type: 'Data' } as unknown as FameEnvelope['frame'], 'env'),
      {
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'origin',
      } as FameDeliveryContext
    );

    const spy = jest.spyOn(handler, 'maybeRequestSigningKey');
    await handler.retryPendingKeyRequestsAfterAttachment();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns immediately when there are no pending envelopes', async () => {
    const { handler } = createHandler();

    await handler.retryPendingKeyRequestsAfterAttachment();

    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      'retrying_pending_key_requests_after_attachment',
      expect.any(Object)
    );
  });

  it('ignores pending envelopes missing origin type', async () => {
    const { handler } = createHandler();
    handler.queuePendingSignedEnvelope(
      'kid-missing-origin',
      makeEnvelope({ type: 'Data' } as unknown as FameEnvelope['frame'], 'env'),
      {} as FameDeliveryContext
    );

    const spy = jest.spyOn(handler, 'maybeRequestSigningKey');
    await handler.retryPendingKeyRequestsAfterAttachment();
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses pending-attachment default when system id is absent', async () => {
    const { handler } = createHandler();
    const spy = jest
      .spyOn(handler, 'maybeRequestSigningKey')
      .mockResolvedValue(undefined);

    handler.queuePendingSignedEnvelope(
      'kid-no-system',
      makeEnvelope({ type: 'Data' } as unknown as FameEnvelope['frame'], 'env'),
      {
        originType: DeliveryOriginType.UPSTREAM,
      } as FameDeliveryContext
    );

    await handler.retryPendingKeyRequestsAfterAttachment();

    expect(spy).toHaveBeenCalledWith(
      'kid-no-system',
      DeliveryOriginType.UPSTREAM,
      'pending-attachment'
    );
  });
});

describe('KeyManagementHandler.hasKey', () => {
  it('returns false when no key manager is configured', async () => {
    const { handler } = createHandler({ keyManager: null });
    await expect(handler.hasKey('kid')).resolves.toBe(false);
  });

  it('delegates to the key manager when available', async () => {
    const keyManager = {
      addKeys: jest.fn(),
      hasKey: jest.fn(async () => true),
    } as unknown as KeyManager;
    const { handler } = createHandler({ keyManager });

    await expect(handler.hasKey('kid-present')).resolves.toBe(true);
    expect(keyManager.hasKey).toHaveBeenCalledWith('kid-present');
  });
});

describe('KeyManagementHandler signing key requests', () => {
  it('handles physical path lookup failures gracefully', async () => {
    const node = createMockNode({
      physicalPathDescriptor: {
        configurable: true,
        get: () => {
          throw new Error('not ready');
        },
      },
    });
    const { handler } = createHandler({ node });

    await handler.maybeRequestSigningKey(
      'kid',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'skipping_key_request_during_attachment',
      expect.objectContaining({
        kid: 'kid',
        reason: 'physical_path_not_yet_available',
        trace_id: undefined,
      })
    );
    expect((handler as any).pendingKeyRequests.has('kid')).toBe(false);
  });

  it('forwards signing key requests upstream', async () => {
    const { handler, node } = createHandler();

    await handler.maybeRequestSigningKey(
      'kid-up',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
    await flushAll();

    expect(node.forwardUpstream).toHaveBeenCalled();
    expect((handler as any).pendingKeyRequests.has('kid-up')).toBe(true);
  });

  it('requires routing support when forwarding to peers', async () => {
    const { handler } = createHandler();

    await expect(
      handler.maybeRequestSigningKey(
        'kid-peer',
        DeliveryOriginType.PEER,
        'peer-1'
      )
    ).rejects.toThrow(
      'Key requests to peers are only supported on routing nodes'
    );
  });

  it('forwards signing key requests to peers when available', async () => {
    const forwardToPeer = jest.fn(async () => undefined);
    const node = createMockNode({ forwardToPeer });
    const { handler } = createHandler({ node });

    await handler.maybeRequestSigningKey(
      'kid-peer',
      DeliveryOriginType.PEER,
      'peer-1'
    );
    await flushAll();

    expect(forwardToPeer).toHaveBeenCalledWith(
      'peer-1',
      expect.objectContaining({
        frame: expect.objectContaining({ kid: 'kid-peer' }),
      }),
      expect.any(Object)
    );
  });

  it('avoids duplicate signing key requests for the same kid', async () => {
    const { handler, node } = createHandler();

    await handler.maybeRequestSigningKey(
      'kid-dup',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
    await handler.maybeRequestSigningKey(
      'kid-dup',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
    await flushAll();

    expect(node.forwardUpstream).toHaveBeenCalledTimes(1);
  });
});

describe('KeyManagementHandler encryption key requests', () => {
  it('enforces local origin when requesting encryption keys', async () => {
    const { handler } = createHandler();

    await expect(
      handler.maybeRequestEncryptionKey('kid', DeliveryOriginType.PEER, 'peer')
    ).rejects.toThrow(
      'Encryption key requests are only supported for local origin'
    );
  });

  it('requests encryption keys by id and by address', async () => {
    const { handler, node } = createHandler();

    await handler.maybeRequestEncryptionKey(
      'kid-enc',
      DeliveryOriginType.LOCAL,
      'local'
    );
    await handler.maybeRequestEncryptionKeyByAddress(
      FameAddress.create('svc@/secure'),
      DeliveryOriginType.LOCAL,
      'local'
    );

    await flushAll();

    expect(node.forwardUpstream).toHaveBeenCalledTimes(2);
    expect((handler as any).pendingEncryptionKeyRequests.size).toBeGreaterThan(
      0
    );
  });

  it('avoids duplicate encryption key requests for the same kid', async () => {
    const { handler, node } = createHandler();

    await handler.maybeRequestEncryptionKey(
      'kid-enc-dup',
      DeliveryOriginType.LOCAL,
      'local'
    );
    await handler.maybeRequestEncryptionKey(
      'kid-enc-dup',
      DeliveryOriginType.LOCAL,
      'local'
    );
    await flushAll();

    expect(node.forwardUpstream).toHaveBeenCalledTimes(1);
  });

  it('avoids duplicate encryption key requests by address', async () => {
    const { handler, node } = createHandler();
    const address = FameAddress.create('svc@/addr');

    await handler.maybeRequestEncryptionKeyByAddress(
      address,
      DeliveryOriginType.LOCAL,
      'local'
    );
    await handler.maybeRequestEncryptionKeyByAddress(
      address,
      DeliveryOriginType.LOCAL,
      'local'
    );
    await flushAll();

    expect(node.forwardUpstream).toHaveBeenCalledTimes(1);
  });
});

describe('KeyManagementHandler key arrival handling', () => {
  it('resolves pending envelopes when a new key arrives', async () => {
    const { handler, node } = createHandler({ encryptionManager: null });

    const kid = 'kid-new';
    const deferred = createDeferred();
    (handler as any).pendingKeyRequests.set(kid, {
      deferred,
      origin: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'origin',
      expiresAt: 0,
      retries: 0,
    });

    handler.queuePendingSignedEnvelope(
      kid,
      makeEnvelope({ type: 'Data' } as unknown as FameEnvelope['frame'], 'env'),
      {
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'origin',
      } as FameDeliveryContext
    );

    handler.queuePendingEncryptionEnvelope(
      kid,
      makeEnvelope({ type: 'Data' } as unknown as FameEnvelope['frame'], 'env'),
      {
        originType: DeliveryOriginType.UPSTREAM,
        fromSystemId: 'origin',
      } as FameDeliveryContext
    );

    (handler as any).onNewKey(kid);
    await deferred.promise;
    await flushAll();

    expect(node.deliver).toHaveBeenCalled();
    expect((handler as any).pendingKeyRequests.has(kid)).toBe(false);
  });
});

describe('KeyManagementHandler deferred handling', () => {
  it('ignores redundant resolve and reject calls on pending requests', async () => {
    const { handler } = createHandler();

    await handler.maybeRequestSigningKey(
      'kid-resolve',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
    await flushAll();

    const pendingRequests = (handler as any).pendingKeyRequests as Map<
      string,
      any
    >;

    const resolveEntry = pendingRequests.get('kid-resolve');
    resolveEntry.deferred.resolve();
    resolveEntry.deferred.resolve();
    await resolveEntry.deferred.promise;

    await handler.maybeRequestSigningKey(
      'kid-reject',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
    const rejectEntry = pendingRequests.get('kid-reject');
    const rejection = rejectEntry.deferred.promise.catch(() => undefined);
    rejectEntry.deferred.reject(new Error('boom'));
    rejectEntry.deferred.reject(new Error('ignored'));
    await rejection;
  });

  it('uses Date.now when performance.now is unavailable', async () => {
    const { handler } = createHandler();
    const globalObj = globalThis as Record<string, unknown>;
    const originalPerformance = globalObj.performance as
      | Performance
      | undefined;
    delete globalObj.performance;

    try {
      await handler.maybeRequestSigningKey(
        'kid-monotonic',
        DeliveryOriginType.UPSTREAM,
        'origin'
      );
    } finally {
      if (originalPerformance) {
        globalObj.performance = originalPerformance;
      } else {
        delete globalObj.performance;
      }
    }
  });
});

describe('KeyManagementHandler sweepKeyRequests', () => {
  it('retries expired requests before eventually failing and cleaning up', async () => {
    const { handler } = createHandler();

    await handler.maybeRequestSigningKey(
      'kid-expire',
      DeliveryOriginType.UPSTREAM,
      'origin'
    );
    await flushAll();

    const retrySpy = jest
      .spyOn(handler, 'maybeRequestSigningKey')
      .mockResolvedValue(undefined);

    const requestMap = (handler as any).pendingKeyRequests as Map<string, any>;
    const request = requestMap.get('kid-expire');
    request.expiresAt = -1;

    const pendingEnvelope = makeEnvelope(
      { type: 'Data' } as unknown as FameEnvelope['frame'],
      'pending'
    );
    const pendingMap = (handler as any).pendingEnvelopes as Map<string, any>;
    pendingMap.set('kid-expire', [
      { envelope: pendingEnvelope, context: {} as FameDeliveryContext },
    ]);

    await (handler as any).sweepKeyRequests({
      requestMap,
      pendingMap,
      now: 0,
      requestType: 'signing',
      onRetry: handler.maybeRequestSigningKey.bind(handler),
      onFailure: jest.fn(),
    });

    expect(retrySpy).toHaveBeenCalled();
    expect(request.retries).toBe(1);

    request.retries = 2;
    request.expiresAt = -1;

    const failureSpy = jest.fn();
    await expect(
      (handler as any).sweepKeyRequests({
        requestMap,
        pendingMap,
        now: 0,
        requestType: 'signing',
        onRetry: handler.maybeRequestSigningKey.bind(handler),
        onFailure: failureSpy,
      })
    ).resolves.toBeUndefined();

    await expect(request.deferred.promise).rejects.toThrow(
      'signing key fetch failed'
    );
    expect(failureSpy).toHaveBeenCalledWith('kid-expire');
    expect(requestMap.has('kid-expire')).toBe(false);
  });

  it('cleans settled entries, skips fresh requests, and prunes empty pendings', async () => {
    const { handler } = createHandler();

    const settled = createDeferred();
    settled.resolve();

    const fresh = createDeferred();

    const requestMap = new Map<string, any>([
      [
        'kid-settled',
        {
          deferred: settled,
          origin: DeliveryOriginType.UPSTREAM,
          fromSystemId: 'origin',
          expiresAt: 100,
          retries: 0,
        },
      ],
      [
        'kid-fresh',
        {
          deferred: fresh,
          origin: DeliveryOriginType.UPSTREAM,
          fromSystemId: 'origin',
          expiresAt: 10,
          retries: 0,
        },
      ],
    ]);

    const pendingMap = new Map<string, any>([['kid-empty', []]]);

    const onRetry = jest.fn().mockResolvedValue(undefined);
    const onFailure = jest.fn();

    await (handler as any).sweepKeyRequests({
      requestMap,
      pendingMap,
      now: 0,
      requestType: 'signing',
      onRetry,
      onFailure,
    });

    expect(requestMap.has('kid-settled')).toBe(false);
    expect(requestMap.has('kid-fresh')).toBe(true);
    expect(onRetry).not.toHaveBeenCalled();
    expect(pendingMap.size).toBe(0);
  });
});

describe('KeyManagementHandler.gcKeyRequests', () => {
  it('logs and cleans up pending requests when retries exhaust', async () => {
    const { handler } = createHandler();

    const signingEnvelope = makeEnvelope(
      { type: 'Data' } as FameEnvelope['frame'],
      'sign-env'
    );
    const encryptionEnvelope = makeEnvelope(
      { type: 'Data' } as FameEnvelope['frame'],
      'enc-env'
    );

    const pendingsMap = (handler as any).pendingEnvelopes as Map<string, any>;
    pendingsMap.set('signing-kid', [
      { envelope: signingEnvelope, context: {} as FameDeliveryContext },
    ]);

    const encPendingsMap = (handler as any).pendingEncryptionEnvelopes as Map<
      string,
      any
    >;
    encPendingsMap.set('encryption-kid', [
      { envelope: encryptionEnvelope, context: {} as FameDeliveryContext },
    ]);

    const correlationMap = (handler as any).correlationToAddress as Map<
      string,
      string
    >;
    correlationMap.set('corr', 'encryption-kid');

    delaySpy.mockResolvedValue(undefined);

    const sweepSpy = jest
      .spyOn(handler as any, 'sweepKeyRequests')
      .mockImplementation(async (options: any) => {
        if (options.requestType === 'signing') {
          options.onFailure('signing-kid');
        } else {
          options.onFailure('encryption-kid');
          (handler as any).isStarted = false;
        }
      });

    (handler as any).isStarted = true;

    await (handler as any).gcKeyRequests();

    expect(pendingsMap.size).toBe(0);
    expect(encPendingsMap.size).toBe(0);
    expect(correlationMap.size).toBe(0);
    sweepSpy.mockRestore();
  });
});

describe('KeyManagementHandler.registerOwnPublicKeys', () => {
  it('skips registration when no key manager is present', async () => {
    const { handler } = createHandler({ keyManager: null });
    await (handler as any).registerOwnPublicKeys();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'skipping_own_public_keys_registration_no_key_manager'
    );
  });

  it('adds unique keys from crypto provider and skips duplicates', async () => {
    const keyManager = {
      addKeys: jest.fn(async () => undefined),
      hasKey: jest.fn(async () => false),
    } as unknown as KeyManager;
    const cryptoProvider: CryptoProvider = {
      nodeJwk: () => ({ kid: 'kidA', use: 'sig' }),
      getJwks: () => ({
        keys: [
          { kid: 'kidA', use: 'sig' },
          { kid: 'kidB', use: 'enc' },
        ],
      }),
    };
    const { handler, node } = createHandler({
      keyManager,
      node: createMockNode({ cryptoProvider }),
    });

    await (handler as any).registerOwnPublicKeys();

    expect(keyManager.addKeys).toHaveBeenCalledWith({
      keys: [
        { kid: 'kidA', use: 'sig' },
        { kid: 'kidB', use: 'enc' },
      ],
      physicalPath: (node as any).physicalPath,
      systemId: node.id,
      origin: DeliveryOriginType.LOCAL,
    });
  });

  it('returns when crypto provider is unavailable', async () => {
    const keyManager = {
      addKeys: jest.fn(),
      hasKey: jest.fn(),
    } as unknown as KeyManager;
    const { handler } = createHandler({
      keyManager,
      node: createMockNode({ cryptoProvider: null }),
    });
    await (handler as any).registerOwnPublicKeys();

    expect(keyManager.addKeys).not.toHaveBeenCalled();
  });

  it('returns early when crypto provider supplies no keys', async () => {
    const keyManager = {
      addKeys: jest.fn(),
      hasKey: jest.fn(),
    } as unknown as KeyManager;
    const cryptoProvider: CryptoProvider = {
      nodeJwk: () => undefined,
      getJwks: () => ({ keys: [] }),
    };
    const { handler } = createHandler({
      keyManager,
      node: createMockNode({ cryptoProvider }),
    });

    await (handler as any).registerOwnPublicKeys();

    expect(keyManager.addKeys).not.toHaveBeenCalled();
  });

  it('handles crypto providers without JWKS gracefully', async () => {
    const keyManager = {
      addKeys: jest.fn(),
      hasKey: jest.fn(),
    } as unknown as KeyManager;
    const cryptoProvider: CryptoProvider = {
      nodeJwk: () => ({ kid: 'node', use: 'sig' }),
      getJwks: () => undefined,
    };
    const { handler } = createHandler({
      keyManager,
      node: createMockNode({ cryptoProvider }),
    });

    await (handler as any).registerOwnPublicKeys();

    expect(keyManager.addKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: [{ kid: 'node', use: 'sig' }],
      })
    );
  });
});

describe('KeyManagementHandler.buildKeyRequestEnvelopeOptions', () => {
  it('includes the current trace id when available', () => {
    const { handler } = createHandler();

    currentTraceIdSpy.mockReturnValue('trace-123');

    const frame = {
      type: 'KeyRequest',
      kid: 'kid-1',
      physicalPath: '/physical',
    } as KeyRequestFrame;

    const options = (handler as any).buildKeyRequestEnvelopeOptions(
      frame,
      'corr-123'
    );

    expect(options.traceId).toBe('trace-123');
    expect(options.corrId).toBe('corr-123');
    expect(options.frame).toBe(frame);
  });
});

describe('KeyManagementHandler.getEncryptionKeyNotifier', () => {
  it('returns null when notifyKeyAvailable is missing', () => {
    const { handler } = createHandler({
      encryptionManager: {} as EncryptionManager,
    });

    const notifier = (handler as any).getEncryptionKeyNotifier();

    expect(notifier).toBeNull();
  });
});
