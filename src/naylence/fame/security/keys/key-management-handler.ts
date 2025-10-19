import {
  DeliveryOriginType,
  type CreateFameEnvelopeOptions,
  type FameAddress,
  type FameDeliveryContext,
  type FameEnvelope,
  type KeyAnnounceFrame,
  type KeyRequestFrame,
  generateId,
  localDeliveryContext,
} from 'naylence-core';

import { currentTraceId } from '../../util/envelope-context.js';
import { getLogger } from '../../util/logging.js';
import { delay } from '../../util/task-utils.js';
import { TaskSpawner } from '../../util/task-spawner.js';
import type { NodeLike } from '../../node/node-like.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';
import type { AttachmentKeyValidator } from './attachment-key-validator.js';
import { KeyValidationError } from './attachment-key-validator.js';
import type { KeyManager } from './key-manager.js';
import type { EncryptionManager } from '../encryption/encryption-manager.js';

const logger = getLogger('naylence.fame.security.keys.key_management_handler');

const KEY_REQUEST_TIMEOUT_MS = 5_000;
const KEY_REQUEST_RETRIES = 3;
const KEY_GC_INTERVAL_MS = 10_000;

interface PendingEnvelope {
  envelope: FameEnvelope;
  context: FameDeliveryContext;
}

interface PendingRequest {
  deferred: Deferred<void>;
  origin: DeliveryOriginType;
  fromSystemId: string;
  expiresAt: number;
  retries: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
  readonly settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (!settled) {
        settled = true;
        res(value);
      }
    };
    reject = (reason) => {
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

function monotonicNow(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return performance.now();
  }
  return Date.now();
}

function getKeyId(key: Record<string, unknown>): string | null {
  const kid = key?.kid;
  return typeof kid === 'string' ? kid : null;
}

export class KeyManagementHandler extends TaskSpawner {
  private readonly node: NodeLike;
  private readonly keyManager: KeyManager | null;
  private readonly keyValidator: AttachmentKeyValidator;
  private readonly encryptionManager: EncryptionManager | null;

  private readonly pendingKeyRequests = new Map<string, PendingRequest>();
  public readonly pendingEnvelopes = new Map<string, PendingEnvelope[]>();

  public readonly pendingEncryptionEnvelopes = new Map<
    string,
    PendingEnvelope[]
  >();
  private readonly pendingEncryptionKeyRequests = new Map<
    string,
    PendingRequest
  >();

  private readonly correlationToAddress = new Map<string, string>();

  private isStarted = false;

  constructor(options: {
    node: NodeLike;
    keyManager: KeyManager | null;
    keyValidator: AttachmentKeyValidator;
    encryptionManager?: EncryptionManager | null;
  }) {
    super();
    this.node = options.node;
    this.keyManager = options.keyManager;
    this.keyValidator = options.keyValidator;
    this.encryptionManager = options.encryptionManager ?? null;
  }

  public async start(): Promise<void> {
    this.isStarted = true;
    this.spawn((signal) => this.gcKeyRequests(signal), {
      name: 'key-request-gc',
    });
    await this.registerOwnPublicKeys();

    // Announce own keys after registration
    if (this.keyManager) {
      await this.keyManager.announceKeysToUpstream();
    }
  }

  public async stop(): Promise<void> {
    this.isStarted = false;
    await delay(100);
    await this.shutdownTasks({
      gracePeriod: 10,
      cancelHanging: true,
      joinTimeout: 1_000,
    });
  }

  public async acceptKeyAnnounce(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const frame = envelope.frame as KeyAnnounceFrame | undefined;

    if (!frame || frame.type !== 'KeyAnnounce') {
      logger.warning('unexpected_frame_type_for_key_announce', {
        envp_id: envelope.id,
        frame_type: frame?.type,
      });
      return;
    }

    if (!this.keyManager) {
      logger.debug('skipping_key_announce_no_key_manager', {
        envelope_id: envelope.id,
      });
      return;
    }

    if (!context) {
      throw new Error('KeyAnnounce handling requires delivery context');
    }

    if (!context.originType) {
      throw new Error(
        'Delivery context must include originType for KeyAnnounce'
      );
    }

    const originSystemId = this.getSourceSystemId(context);
    if (!originSystemId) {
      logger.warning('key_announce_missing_origin_system_id', {
        envelope_id: envelope.id,
      });
      return;
    }

    const validatedKeys: Array<Record<string, unknown>> = [];
    let rejectedCount = 0;

    for (const key of frame.keys ?? []) {
      try {
        await this.keyValidator.validateKey(key);
        validatedKeys.push(key);
      } catch (error) {
        if (error instanceof KeyValidationError) {
          logger.warning('skipping_key_due_to_certificate_validation_failure', {
            kid: getKeyId(key) ?? 'unknown',
            from_system_id: originSystemId,
            from_physical_path: frame.physicalPath,
            error: error.message,
            scenario: 'on_demand_key_request',
            action: 'skipped_key_not_added_to_store',
          });
          rejectedCount += 1;
        } else {
          throw error;
        }
      }
    }

    if (validatedKeys.length === 0) {
      logger.warning('no_valid_keys_remaining_after_certificate_validation', {
        from_system_id: originSystemId,
        from_physical_path: frame.physicalPath,
        total_keys: frame.keys?.length ?? 0,
        scenario: 'on_demand_key_request',
      });
      return;
    }

    const isCorrelationRouted = typeof envelope.corrId === 'string';

    const addKeysOptions: Parameters<KeyManager['addKeys']>[0] = {
      keys: validatedKeys,
      physicalPath: frame.physicalPath,
      systemId: originSystemId,
      origin: context.originType,
      skipSidValidation: isCorrelationRouted,
    };

    if (envelope.sid) {
      addKeysOptions.sid = envelope.sid;
    }

    await this.keyManager.addKeys(addKeysOptions);

    for (const key of validatedKeys) {
      const kid = getKeyId(key);
      if (kid) {
        this.onNewKey(kid);
      }
    }

    let correlationAddressHandled: string | null = null;

    if (isCorrelationRouted && envelope.corrId) {
      const originalAddress = this.correlationToAddress.get(envelope.corrId);
      if (originalAddress) {
        this.correlationToAddress.delete(envelope.corrId);

        const addKeysForAddress: Parameters<KeyManager['addKeys']>[0] = {
          keys: validatedKeys,
          physicalPath: originalAddress,
          systemId: originSystemId,
          origin: context.originType,
          skipSidValidation: true,
        };

        if (envelope.sid) {
          addKeysForAddress.sid = envelope.sid;
        }

        await this.keyManager.addKeys(addKeysForAddress);

        logger.debug('added_keys_for_target_address', {
          target_address: originalAddress,
          key_count: validatedKeys.length,
        });

        this.onNewKeyForAddressByCorrelation(originalAddress, validatedKeys);
        correlationAddressHandled = originalAddress;
      }
    }

    if (frame.address) {
      const addressKey = String(frame.address);

      try {
        if (correlationAddressHandled !== addressKey) {
          const addKeysForAnnouncedAddress: Parameters<
            KeyManager['addKeys']
          >[0] = {
            keys: validatedKeys,
            physicalPath: addressKey,
            systemId: originSystemId,
            origin: context.originType,
            skipSidValidation: true,
          };

          if (envelope.sid) {
            addKeysForAnnouncedAddress.sid = envelope.sid;
          }

          await this.keyManager.addKeys(addKeysForAnnouncedAddress);

          logger.debug('added_keys_for_announced_address', {
            target_address: addressKey,
            key_count: validatedKeys.length,
          });
        }
      } catch (error) {
        logger.warning('failed_to_add_keys_for_announced_address', {
          target_address: addressKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      this.onNewKeyForAddress(frame.address, validatedKeys);
    }

    if (rejectedCount > 0) {
      logger.debug('key_validation_rejections', {
        rejected_count: rejectedCount,
        accepted_count: validatedKeys.length,
      });
    }
  }

  public async hasKey(kid: string): Promise<boolean> {
    if (!this.keyManager) return false;
    return await this.keyManager.hasKey(kid);
  }

  public async retryPendingKeyRequestsAfterAttachment(): Promise<void> {
    if (this.pendingEnvelopes.size === 0) {
      return;
    }

    logger.debug('retrying_pending_key_requests_after_attachment', {
      pending_kids: Array.from(this.pendingEnvelopes.keys()),
    });

    const toRetry: Array<{
      kid: string;
      origin: DeliveryOriginType;
      fromSystemId: string;
    }> = [];

    for (const [kid, pending] of this.pendingEnvelopes.entries()) {
      if (
        !pending ||
        pending.length === 0 ||
        this.pendingKeyRequests.has(kid)
      ) {
        continue;
      }

      const firstContext = pending[0]?.context;
      if (!firstContext?.originType) {
        continue;
      }

      toRetry.push({
        kid,
        origin: firstContext.originType,
        fromSystemId: firstContext.fromSystemId ?? 'pending-attachment',
      });
    }

    for (const entry of toRetry) {
      await this.maybeRequestSigningKey(
        entry.kid,
        entry.origin,
        entry.fromSystemId
      );
    }
  }

  public async maybeRequestSigningKey(
    kid: string,
    origin: DeliveryOriginType,
    fromSystemId: string
  ): Promise<void> {
    if (this.pendingKeyRequests.has(kid) || !this.node.hasParent) {
      return;
    }

    let physicalPath: string;
    try {
      physicalPath = this.node.physicalPath;
    } catch (error) {
      logger.debug('skipping_key_request_during_attachment', {
        kid,
        reason: 'physical_path_not_yet_available',
        trace_id: currentTraceId(),
      });
      return;
    }

    logger.debug('requesting_key_from_parent', {
      kid,
      trace_id: currentTraceId(),
    });

    const deferred = createDeferred<void>();
    this.pendingKeyRequests.set(kid, {
      deferred,
      origin,
      fromSystemId,
      expiresAt: monotonicNow() + KEY_REQUEST_TIMEOUT_MS,
      retries: 0,
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid,
      physicalPath,
    };

    const envelope = this.node.envelopeFactory.createEnvelope(
      this.buildKeyRequestEnvelopeOptions(frame)
    );

    logger.debug('sending_signing_key_request', { kid });

    if (origin === DeliveryOriginType.UPSTREAM) {
      this.spawn(
        async () => {
          await this.node.forwardUpstream(
            envelope,
            localDeliveryContext(this.node.id)
          );
        },
        { name: `send-keyreq-upstream-${kid}` }
      );
    } else if (origin === DeliveryOriginType.PEER) {
      const routingNode = this.node as RoutingNodeLike & {
        forwardToPeer?: (
          segment: string,
          env: FameEnvelope,
          context?: FameDeliveryContext
        ) => Promise<void>;
      };

      const forwardToPeer = routingNode.forwardToPeer?.bind(routingNode);
      if (!forwardToPeer) {
        throw new Error(
          'Key requests to peers are only supported on routing nodes'
        );
      }

      this.spawn(
        async () => {
          await forwardToPeer(
            fromSystemId,
            envelope,
            localDeliveryContext(this.node.id)
          );
        },
        { name: `send-keyreq-peer-${kid}` }
      );
    }
  }

  public async maybeRequestEncryptionKey(
    kid: string,
    origin: DeliveryOriginType,
    fromSystemId: string
  ): Promise<void> {
    if (this.pendingEncryptionKeyRequests.has(kid) || !this.node.hasParent) {
      return;
    }

    if (origin !== DeliveryOriginType.LOCAL) {
      throw new Error(
        'Encryption key requests are only supported for local origin'
      );
    }

    logger.debug('requesting_encryption_key_from_parent', {
      kid,
      trace_id: currentTraceId(),
    });

    const deferred = createDeferred<void>();
    this.pendingEncryptionKeyRequests.set(kid, {
      deferred,
      origin,
      fromSystemId,
      expiresAt: monotonicNow() + KEY_REQUEST_TIMEOUT_MS,
      retries: 0,
    });

    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      kid,
      physicalPath: this.node.physicalPath,
    };

    const envelope = this.node.envelopeFactory.createEnvelope(
      this.buildKeyRequestEnvelopeOptions(frame)
    );

    logger.debug('sending_enc_key_request', { kid });

    this.spawn(
      async () => {
        await this.node.forwardUpstream(
          envelope,
          localDeliveryContext(this.node.id)
        );
      },
      { name: `send-enc-keyreq-${kid}` }
    );
  }

  public async maybeRequestEncryptionKeyByAddress(
    address: FameAddress,
    origin: DeliveryOriginType,
    fromSystemId: string
  ): Promise<void> {
    const addressKey = String(address);

    if (
      this.pendingEncryptionKeyRequests.has(addressKey) ||
      !this.node.hasParent
    ) {
      return;
    }

    if (origin !== DeliveryOriginType.LOCAL) {
      throw new Error(
        'Encryption key requests are only supported for local origin'
      );
    }

    logger.debug('requesting_encryption_key_from_parent_by_address', {
      address: addressKey,
      trace_id: currentTraceId(),
    });

    const deferred = createDeferred<void>();
    this.pendingEncryptionKeyRequests.set(addressKey, {
      deferred,
      origin,
      fromSystemId,
      expiresAt: monotonicNow() + KEY_REQUEST_TIMEOUT_MS,
      retries: 0,
    });

    const corrId = generateId();
    const frame: KeyRequestFrame = {
      type: 'KeyRequest',
      address: addressKey, // Must be string, not FameAddress object
      physicalPath: this.node.physicalPath,
    };

    const envelopeOptions = this.buildKeyRequestEnvelopeOptions(frame, corrId);
    const envelope = this.node.envelopeFactory.createEnvelope(envelopeOptions);

    logger.debug('sending_enc_key_request', { by_address: addressKey });

    this.correlationToAddress.set(corrId, addressKey);

    this.spawn(
      async () => {
        await this.node.forwardUpstream(
          envelope,
          localDeliveryContext(this.node.id)
        );
      },
      { name: `send-enc-keyreq-addr-${addressKey}` }
    );
  }

  public queuePendingSignedEnvelope(
    kid: string,
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): void {
    const queue = this.pendingEnvelopes.get(kid) ?? [];
    queue.push({ envelope, context });
    this.pendingEnvelopes.set(kid, queue);
  }

  public queuePendingEncryptionEnvelope(
    key: string,
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): void {
    const queue = this.pendingEncryptionEnvelopes.get(key) ?? [];
    queue.push({ envelope, context });
    this.pendingEncryptionEnvelopes.set(key, queue);
  }

  private onNewKey(kid: string): void {
    const signingEntry = this.pendingKeyRequests.get(kid);
    if (signingEntry && !signingEntry.deferred.settled) {
      signingEntry.deferred.resolve(undefined);
    }
    this.pendingKeyRequests.delete(kid);

    const encryptionEntry = this.pendingEncryptionKeyRequests.get(kid);
    if (encryptionEntry && !encryptionEntry.deferred.settled) {
      encryptionEntry.deferred.resolve(undefined);
    }
    this.pendingEncryptionKeyRequests.delete(kid);

    this.notifyEncryptionManager(kid);

    const signingPendings = this.pendingEnvelopes.get(kid);
    if (signingPendings) {
      this.pendingEnvelopes.delete(kid);
      for (const pending of signingPendings) {
        this.spawn(
          async () => {
            await this.node.deliver(pending.envelope, pending.context);
          },
          { name: `replay-after-signing-key-${kid}` }
        );
      }
    }

    const encryptionPendings = this.pendingEncryptionEnvelopes.get(kid);
    if (encryptionPendings) {
      this.pendingEncryptionEnvelopes.delete(kid);
      for (const pending of encryptionPendings) {
        this.spawn(
          async () => {
            await this.node.deliver(pending.envelope, pending.context);
          },
          { name: `replay-after-encryption-key-${kid}` }
        );
      }
    }
  }

  private onNewKeyForAddress(
    address: FameAddress,
    keys: Array<Record<string, unknown>>
  ): void {
    const addressKey = String(address);

    logger.debug('processing_key_announce_for_address', {
      address: addressKey,
      key_count: keys.length,
      keys: keys.map((key) => getKeyId(key) ?? 'unknown'),
    });

    for (const key of keys) {
      const kid = getKeyId(key);
      if (!kid) {
        continue;
      }

      // NOTE: Python does NOT notify the encryption manager here for sealed encryption.
      // The KeyManagementHandler handles replay directly.
      // Notifying would cause X25519EncryptionManager to also replay, creating a loop.
      // this.notifyEncryptionManager(kid);
      // const addressBasedKeyId = `request-${addressKey}`;
      // this.notifyEncryptionManager(addressBasedKeyId);
    }

    const entry = this.pendingEncryptionKeyRequests.get(addressKey);
    if (entry && !entry.deferred.settled) {
      entry.deferred.resolve(undefined);
    }
    this.pendingEncryptionKeyRequests.delete(addressKey);

    const pendings = this.pendingEncryptionEnvelopes.get(addressKey);
    if (pendings && pendings.length > 0) {
      logger.debug('replaying_envelopes_for_address', {
        address: addressKey,
        envelope_count: pendings.length,
      });
      this.pendingEncryptionEnvelopes.delete(addressKey);
      for (const pending of pendings) {
        this.spawn(
          async () => {
            await this.node.deliver(pending.envelope, pending.context);
          },
          { name: `replay-after-address-key-${addressKey}` }
        );
      }
    }
  }

  private onNewKeyForAddressByCorrelation(
    addressKey: string,
    keys: Array<Record<string, unknown>>
  ): void {
    logger.debug('processing_key_announce_for_address_by_correlation', {
      address_key: addressKey,
      key_count: keys.length,
      keys: keys.map((key) => getKeyId(key) ?? 'unknown'),
    });

    for (const key of keys) {
      const kid = getKeyId(key);
      if (!kid) {
        continue;
      }

      // NOTE: Python does NOT notify the encryption manager here for sealed encryption.
      // The KeyManagementHandler handles replay directly.
      // Notifying would cause X25519EncryptionManager to also replay, creating a loop.
      // this.notifyEncryptionManager(kid);
      // const addressBasedKeyId = `request-${addressKey}`;
      // this.notifyEncryptionManager(addressBasedKeyId);
    }

    const entry = this.pendingEncryptionKeyRequests.get(addressKey);
    if (entry && !entry.deferred.settled) {
      entry.deferred.resolve(undefined);
    }
    this.pendingEncryptionKeyRequests.delete(addressKey);

    const pendings = this.pendingEncryptionEnvelopes.get(addressKey);
    if (pendings && pendings.length > 0) {
      logger.debug('replaying_envelopes_for_address_by_correlation', {
        address_key: addressKey,
        envelope_count: pendings.length,
      });
      this.pendingEncryptionEnvelopes.delete(addressKey);
      for (const pending of pendings) {
        this.spawn(
          async () => {
            await this.node.deliver(pending.envelope, pending.context);
          },
          { name: `replay-after-address-key-${addressKey}` }
        );
      }
    }
  }

  private async gcKeyRequests(signal?: AbortSignal): Promise<void> {
    try {
      while (this.isStarted && !signal?.aborted) {
        await delay(KEY_GC_INTERVAL_MS, signal);

        if (!this.isStarted || signal?.aborted) {
          break;
        }

        const now = monotonicNow();

        await this.sweepKeyRequests({
          requestMap: this.pendingKeyRequests,
          pendingMap: this.pendingEnvelopes,
          now,
          requestType: 'signing',
          onRetry: (kid, request) =>
            this.maybeRequestSigningKey(
              kid,
              request.origin,
              request.fromSystemId
            ),
          onFailure: (kid) => {
            const pendings = this.pendingEnvelopes.get(kid) ?? [];
            for (const pending of pendings) {
              logger.error('dropping_envelope_missing_signing_key', {
                kid,
                envp_id: pending.envelope.id,
              });
            }
            this.pendingEnvelopes.delete(kid);
          },
        });

        await this.sweepKeyRequests({
          requestMap: this.pendingEncryptionKeyRequests,
          pendingMap: this.pendingEncryptionEnvelopes,
          now,
          requestType: 'encryption',
          onRetry: (kid, request) =>
            this.maybeRequestEncryptionKey(
              kid,
              request.origin,
              request.fromSystemId
            ),
          onFailure: (kid) => {
            const pendings = this.pendingEncryptionEnvelopes.get(kid) ?? [];
            for (const pending of pendings) {
              logger.error('dropping_envelope_missing_encryption_key', {
                kid,
                envp_id: pending.envelope.id,
              });
            }
            this.pendingEncryptionEnvelopes.delete(kid);

            for (const [corrId, addrKey] of Array.from(
              this.correlationToAddress.entries()
            )) {
              if (addrKey === kid) {
                this.correlationToAddress.delete(corrId);
              }
            }
          },
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message === 'Aborted')
      ) {
        logger.debug('key_request_gc_cancelled');
      } else {
        logger.error('key_request_gc_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.pendingKeyRequests.clear();
      this.pendingEnvelopes.clear();
      this.pendingEncryptionKeyRequests.clear();
      this.pendingEncryptionEnvelopes.clear();
      this.correlationToAddress.clear();
    }
  }

  private async sweepKeyRequests(options: {
    requestMap: Map<string, PendingRequest>;
    pendingMap: Map<string, PendingEnvelope[]>;
    now: number;
    requestType: 'signing' | 'encryption';
    onRetry: (kid: string, request: PendingRequest) => Promise<void>;
    onFailure: (kid: string) => void;
  }): Promise<void> {
    const { requestMap, pendingMap, now, requestType, onRetry, onFailure } =
      options;

    for (const [kid, request] of Array.from(requestMap.entries())) {
      if (request.deferred.settled) {
        requestMap.delete(kid);
        continue;
      }

      if (now < request.expiresAt) {
        continue;
      }

      if (request.retries + 1 < KEY_REQUEST_RETRIES) {
        logger.warning(`${requestType}_key_request_retry`, {
          kid,
          attempt: request.retries + 2,
        });

        request.retries += 1;
        request.expiresAt = now + KEY_REQUEST_TIMEOUT_MS;
        await onRetry(kid, request);
      } else {
        logger.error(`${requestType}_key_request_failed`, { kid });
        request.deferred.reject(new Error(`${requestType} key fetch failed`));
        onFailure(kid);
        requestMap.delete(kid);
      }
    }

    for (const [kid, pending] of Array.from(pendingMap.entries())) {
      if (!pending || pending.length === 0) {
        pendingMap.delete(kid);
      }
    }
  }

  private async registerOwnPublicKeys(): Promise<void> {
    if (!this.keyManager) {
      logger.debug('skipping_own_public_keys_registration_no_key_manager');
      return;
    }

    const cryptoProvider = this.node.cryptoProvider; //getCryptoProvider();
    if (!cryptoProvider) {
      return;
    }

    const keys: Array<Record<string, unknown>> = [];

    const nodeJwk = cryptoProvider.nodeJwk?.();
    if (nodeJwk) {
      keys.push(nodeJwk as Record<string, unknown>);
    }

    const jwks = cryptoProvider.getJwks?.();
    if (jwks?.keys) {
      for (const jwk of jwks.keys) {
        if (
          nodeJwk &&
          getKeyId(jwk) === getKeyId(nodeJwk) &&
          jwk.use !== 'enc'
        ) {
          continue;
        }
        keys.push(jwk as Record<string, unknown>);
      }
    }

    if (keys.length === 0) {
      return;
    }

    await this.keyManager.addKeys({
      keys,
      physicalPath: this.node.physicalPath,
      systemId: this.node.id,
      origin: DeliveryOriginType.LOCAL,
    });
  }

  private getSourceSystemId(context: FameDeliveryContext): string | null {
    return context.fromSystemId ?? null;
  }

  private buildKeyRequestEnvelopeOptions(
    frame: KeyRequestFrame,
    corrId?: string
  ): CreateFameEnvelopeOptions {
    const options: CreateFameEnvelopeOptions = {
      frame,
      corrId: corrId ?? generateId(),
    };

    const traceId = currentTraceId();
    if (traceId) {
      options.traceId = traceId;
    }

    return options;
  }

  private getEncryptionKeyNotifier():
    | ((kid: string) => Promise<void> | void)
    | null {
    if (!this.encryptionManager) {
      return null;
    }

    const candidate = this.encryptionManager as EncryptionManager & {
      notifyKeyAvailable?: (kid: string) => Promise<void> | void;
    };

    if (typeof candidate.notifyKeyAvailable !== 'function') {
      return null;
    }

    return candidate.notifyKeyAvailable.bind(candidate);
  }

  private notifyEncryptionManager(kid: string): void {
    const notifier = this.getEncryptionKeyNotifier();
    if (!notifier) {
      return;
    }

    this.spawn(
      async () => {
        await notifier(kid);
      },
      { name: `notify-encryption-manager-${kid}` }
    );
  }
}
