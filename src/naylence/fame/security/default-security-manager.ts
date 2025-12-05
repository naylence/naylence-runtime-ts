import {
  DeliveryOriginType,
  FameResponseType,
  type AuthorizationContext,
  type CreateFameEnvelopeOptions,
  type DataFrame,
  type FameAddress,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type KeyRequestFrame,
  type NodeAttachFrame,
  type NodeWelcomeFrame,
} from '@naylence/core';

import type { Authorizer } from './auth/authorizer.js';
import type { CryptoProvider } from './crypto/providers/crypto-provider.js';
import type { EncryptionManager } from './encryption/encryption-manager.js';
import type { SecureChannelManager } from './encryption/secure-channel-manager.js';
import type { AttachmentKeyValidator } from './keys/attachment-key-validator.js';
import type { CertificateManager } from './cert/certificate-manager.js';
import type { KeyManager } from './keys/key-manager.js';
import { KeyManagementHandler } from './keys/key-management-handler.js';
import type { EnvelopeSigner } from './signing/envelope-signer.js';
import type { EnvelopeVerifier } from './signing/envelope-verifier.js';
import type { SecurityManager } from './security-manager.js';
import {
  SecurityAction,
  type SecurityPolicy,
} from './policy/security-policy.js';
import type { AttachInfo } from '../node/admission/node-attach-client.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import type { NodeLike } from '../node/node-like.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import { EnvelopeSecurityHandler } from '../node/envelope-security-handler.js';
import { SecureChannelFrameHandler } from '../node/secure-channel-frame-handler.js';
import { KeyFrameHandler } from '../sentinel/key-frame-handler.js';
import { getLogger } from '../util/logging.js';
import { secureDigest } from '../util/util.js';
import { canonicalJson } from '../security/signing/eddsa-signer-verifier.js';
import { currentTraceId } from '../util/envelope-context.js';
import { FameTransportClose } from '../errors/errors.js';
import type { SecurityContext } from '@naylence/core';

type KeyFrameHandlerOptions = ConstructorParameters<typeof KeyFrameHandler>[0];
type KeyFrameRouteManager = KeyFrameHandlerOptions['routeManager'];
type KeyFrameBindingManager = KeyFrameHandlerOptions['bindingManager'];
type HandleKeyRequestOptions = Parameters<KeyManager['handleKeyRequest']>[0];

type DeliveryContextAliases = {
  origin_type?: DeliveryOriginType;
  from_system_id?: FameDeliveryContext['fromSystemId'];
  expected_response_type?: FameDeliveryContext['expectedResponseType'];
  stickiness_required?: boolean;
  sticky_sid?: string;
  corr_id?: string;
  trace_id?: string;
};

type DeliveryContextWithAliases = FameDeliveryContext &
  DeliveryContextAliases & {
    corrId?: string;
    traceId?: string;
    stickinessRequired?: boolean;
    stickySid?: string;
  };

function normalizeContextAliases(
  context: DeliveryContextWithAliases
): DeliveryContextWithAliases {
  const normalized = context;

  if (
    normalized.originType === undefined &&
    context.origin_type !== undefined
  ) {
    normalized.originType = context.origin_type;
  }

  if (
    normalized.fromSystemId === undefined &&
    context.from_system_id !== undefined
  ) {
    normalized.fromSystemId = context.from_system_id;
  }

  if (
    normalized.expectedResponseType === undefined &&
    context.expected_response_type !== undefined
  ) {
    normalized.expectedResponseType = context.expected_response_type;
  }

  if (
    normalized.stickinessRequired === undefined &&
    context.stickiness_required !== undefined
  ) {
    normalized.stickinessRequired = context.stickiness_required;
  }

  if (normalized.stickySid === undefined && context.sticky_sid !== undefined) {
    normalized.stickySid = context.sticky_sid;
  }

  if (normalized.corrId === undefined && context.corr_id !== undefined) {
    normalized.corrId = context.corr_id;
  }

  if (normalized.traceId === undefined && context.trace_id !== undefined) {
    normalized.traceId = context.trace_id;
  }

  return normalized;
}

type NodeAttachValidatingAuthorizer = Authorizer & {
  validateNodeAttachRequest?: (
    node: NodeLike,
    frame: NodeAttachFrame,
    authContext?: AuthorizationContext
  ) =>
    | Promise<AuthorizationContext | undefined>
    | AuthorizationContext
    | undefined;
};

function hasNodeAttachValidation(
  authorizer: Authorizer | null
): authorizer is NodeAttachValidatingAuthorizer {
  return Boolean(
    authorizer &&
      typeof (authorizer as NodeAttachValidatingAuthorizer)
        .validateNodeAttachRequest === 'function'
  );
}

const logger = getLogger('naylence.fame.security.default_security_manager');

type SendCallback = (
  envelope: FameEnvelope,
  context?: FameDeliveryContext | null
) => Promise<void>;

function hasNodeListenerMethod<T extends keyof NodeEventListener, C>(
  candidate: C | null | undefined,
  method: T
): candidate is C & Required<Pick<NodeEventListener, T>> {
  return Boolean(
    candidate &&
      typeof (candidate as Record<string, unknown>)[method] === 'function'
  );
}

function ensureSecurityContext(context: FameDeliveryContext): SecurityContext {
  if (!context.security) {
    context.security = {} as SecurityContext;
  }
  return context.security;
}

function isDataFrame(frame: FameEnvelope['frame']): frame is DataFrame {
  return (
    typeof (frame as DataFrame).type === 'string' &&
    (frame as DataFrame).type === 'Data'
  );
}

function isCriticalFrame(frame: FameEnvelope['frame']): boolean {
  const frameType = frame?.type;
  return (
    frameType === 'KeyRequest' ||
    frameType === 'KeyAnnounce' ||
    frameType === 'SecureOpen' ||
    frameType === 'SecureAccept'
  );
}

function createLocalContext(
  node: NodeLike,
  source?: FameDeliveryContext
): FameDeliveryContext {
  const normalizedSource = source
    ? normalizeContextAliases(source as DeliveryContextWithAliases)
    : undefined;

  const context: FameDeliveryContext = {
    originType: DeliveryOriginType.LOCAL,
    fromSystemId: node.id,
    expectedResponseType: FameResponseType.NONE,
  };

  if (normalizedSource?.meta) {
    context.meta = { ...normalizedSource.meta };
  }

  if (normalizedSource?.security) {
    context.security = normalizedSource.security;
  }

  if (normalizedSource?.stickinessRequired !== undefined) {
    context.stickinessRequired = normalizedSource.stickinessRequired;
  }

  if (normalizedSource?.stickySid !== undefined) {
    context.stickySid = normalizedSource.stickySid;
  }

  if (normalizedSource?.corrId !== undefined) {
    (context as DeliveryContextWithAliases).corrId = normalizedSource.corrId;
  }

  if (normalizedSource?.traceId !== undefined) {
    (context as DeliveryContextWithAliases).traceId = normalizedSource.traceId;
  }

  return context;
}

function normalizeDeliveryContext(
  node: NodeLike,
  context?: FameDeliveryContext
): FameDeliveryContext {
  if (!context) {
    return createLocalContext(node);
  }

  const normalized = normalizeContextAliases(
    context as DeliveryContextWithAliases
  );
  normalized.originType ??= DeliveryOriginType.LOCAL;
  normalized.fromSystemId ??= node.id;
  normalized.expectedResponseType ??= FameResponseType.NONE;

  return normalized;
}
interface SpawnLike {
  spawn?: (
    task: () => Promise<void>,
    options?: { name?: string }
  ) => Promise<unknown> | unknown;
}

export class DefaultSecurityManager implements SecurityManager {
  public readonly priority = 2000;

  private _policy: SecurityPolicy;
  private _envelopeSigner: EnvelopeSigner | null;
  private _envelopeVerifier: EnvelopeVerifier | null;
  private _encryption: EncryptionManager | null;
  private _keyManager: KeyManager | null;
  private _authorizer: Authorizer | null;
  private _certificateManager: CertificateManager | null;
  private _keyValidator: AttachmentKeyValidator | null;
  private _node: NodeLike | null = null;

  private _envelopeSecurityHandler: EnvelopeSecurityHandler | null = null;
  private _secureChannelManager: SecureChannelManager | null;
  private _secureChannelFrameHandler: SecureChannelFrameHandler | null = null;
  private _keyManagementHandler: KeyManagementHandler | null = null;
  private _keyFrameHandler: KeyFrameHandler | null = null;

  public constructor(
    policy: SecurityPolicy,
    envelopeSigner: EnvelopeSigner | null = null,
    envelopeVerifier: EnvelopeVerifier | null = null,
    encryption: EncryptionManager | null = null,
    keyManager: KeyManager | null = null,
    authorizer: Authorizer | null = null,
    certificateManager: CertificateManager | null = null,
    secureChannelManager: SecureChannelManager | null = null,
    keyValidator: AttachmentKeyValidator | null = null
  ) {
    this._policy = policy;
    this._envelopeSigner = envelopeSigner;
    this._envelopeVerifier = envelopeVerifier;
    this._encryption = encryption;
    this._keyManager = keyManager;
    this._authorizer = authorizer;
    this._certificateManager = certificateManager;
    this._secureChannelManager = secureChannelManager;
    this._keyValidator = keyValidator;
  }

  public get policy(): SecurityPolicy {
    return this._policy;
  }

  public set policy(value: SecurityPolicy) {
    this._policy = value;
  }

  public get envelopeSigner(): EnvelopeSigner | null {
    return this._envelopeSigner;
  }

  public set envelopeSigner(value: EnvelopeSigner | null) {
    this._envelopeSigner = value;
  }

  public get envelopeVerifier(): EnvelopeVerifier | null {
    return this._envelopeVerifier;
  }

  public set envelopeVerifier(value: EnvelopeVerifier | null) {
    this._envelopeVerifier = value;
  }

  public get encryption(): EncryptionManager | null {
    return this._encryption;
  }

  public set encryption(value: EncryptionManager | null) {
    this._encryption = value;
  }

  public get keyManager(): KeyManager | null {
    return this._keyManager;
  }

  public set keyManager(value: KeyManager | null) {
    this._keyManager = value;
  }

  public get authorizer(): Authorizer | null {
    return this._authorizer;
  }

  public set authorizer(value: Authorizer | null) {
    this._authorizer = value;
  }

  public get certificateManager(): CertificateManager | null {
    return this._certificateManager;
  }

  public set certificateManager(value: CertificateManager | null) {
    this._certificateManager = value;
  }

  public get cryptoProvider(): CryptoProvider | null {
    if (!this._node) {
      logger.debug('crypto_provider_requested_before_node_initialized');
      throw new Error(
        'DefaultSecurityManager has not been initialized with a node'
      );
    }
    const provider = this._node.cryptoProvider;
    logger.debug('crypto_provider_resolved_from_node', {
      node_id: this._node.id,
      has_provider: Boolean(provider),
      provider_type: provider
        ? (provider.constructor?.name ?? 'unknown')
        : null,
      has_private_key: Boolean(
        provider &&
          (typeof (provider as { signingPrivatePem?: unknown })
            .signingPrivatePem === 'string' ||
            typeof (provider as { signing_private_pem?: unknown })
              .signing_private_pem === 'string')
      ),
    });
    return provider;
  }

  public get envelopeSecurityHandler(): EnvelopeSecurityHandler | null {
    return this._envelopeSecurityHandler;
  }

  public get secureChannelFrameHandler(): SecureChannelFrameHandler | null {
    return this._secureChannelFrameHandler;
  }

  public get supportsOverlaySecurity(): boolean {
    return Boolean(this._envelopeSigner || this._envelopeVerifier);
  }

  public getShareableKeys():
    | Record<string, unknown>
    | Record<string, unknown>[]
    | undefined {
    const keys = this._getKeysToProvide();
    if (!keys || keys.length === 0) {
      return undefined;
    }
    if (keys.length === 1) {
      return keys[0];
    }
    return keys;
  }

  public getEncryptionKeyId(): string | undefined {
    const provider = this.resolveCryptoProvider();
    return provider?.encryptionKeyId ?? undefined;
  }

  public async onNodeStarted(node: NodeLike): Promise<void> {
    if (
      this._certificateManager &&
      hasNodeListenerMethod(this._certificateManager, 'onNodeStarted')
    ) {
      await this._certificateManager.onNodeStarted(node);
    }

    const encryption = this._encryption;
    if (encryption && hasNodeListenerMethod(encryption, 'onNodeStarted')) {
      await encryption.onNodeStarted(node);
    }

    const keyManager = this._keyManager;
    if (keyManager && hasNodeListenerMethod(keyManager, 'onNodeStarted')) {
      await keyManager.onNodeStarted(node);
    }

    if (this._keyManager && this.supportsOverlaySecurity) {
      if (!this._keyValidator) {
        throw new Error(
          'Key validator must be set when overlay security is enabled'
        );
      }

      this._keyManagementHandler = new KeyManagementHandler({
        node,
        keyManager: this._keyManager,
        keyValidator: this._keyValidator,
        encryptionManager: this._encryption ?? null,
      });
      await this._keyManagementHandler.start();
    }

    if (this._keyManagementHandler) {
      this._envelopeSecurityHandler = new EnvelopeSecurityHandler({
        nodeLike: node,
        envelopeSigner: this._envelopeSigner,
        envelopeVerifier: this._envelopeVerifier,
        encryptionManager: this._encryption ?? null,
        securityPolicy: this._policy,
        keyManagementHandler: this._keyManagementHandler,
      });
    } else {
      this._envelopeSecurityHandler = null;
    }

    const sendWithContext: SendCallback = async (envelope, context = null) => {
      const deliveryContext = context ?? {
        originType: DeliveryOriginType.LOCAL,
        fromSystemId: node.id,
        expectedResponseType: FameResponseType.NONE,
      };
      await node.deliver(envelope, deliveryContext);
    };

    if (this.supportsOverlaySecurity) {
      this._secureChannelFrameHandler = new SecureChannelFrameHandler({
        secureChannelManager: this._secureChannelManager,
        envelopeFactory: node.envelopeFactory,
        sendCallback: sendWithContext,
        envelopeSecurityHandler: this._envelopeSecurityHandler,
      });
    } else {
      this._secureChannelFrameHandler = null;
    }

    if (this.supportsOverlaySecurity && this.isRoutingNode(node)) {
      const routingNode = node as RoutingNodeLike;
      const routeManager =
        (node as { _route_manager?: KeyFrameRouteManager | null })
          ._route_manager ?? null;
      const bindingManager =
        (node as { _binding_manager?: KeyFrameBindingManager | null })
          ._binding_manager ?? null;

      if (!bindingManager) {
        throw new Error(
          'Routing node is missing binding manager for key frame handler'
        );
      }

      this._keyFrameHandler = new KeyFrameHandler({
        routingNode,
        routeManager,
        bindingManager,
        acceptKeyAnnounceParent: this._getKeyAnnounceHandler(),
        keyManager: this._keyManager,
      });

      const spawnSource = this.getSpawner(node) ?? this.getSpawner(routingNode);
      if (spawnSource) {
        await this._keyFrameHandler.start(spawnSource);
      } else {
        logger.warning('no_spawner_available_for_key_frame_handler', {
          node_id: node.id,
        });
      }

      logger.debug('key_frame_handler_created_for_sentinel', {
        node_id: node.id,
      });
    } else {
      this._keyFrameHandler = null;
    }

    logger.debug('security_components_initialized', {
      node_id: node.id,
      has_certificate_manager: Boolean(this._certificateManager),
      has_encryption: Boolean(this._encryption),
      has_key_manager: Boolean(this._keyManager),
      has_envelope_security_handler: Boolean(this._envelopeSecurityHandler),
      has_secure_channel_manager: Boolean(this._secureChannelManager),
    });
  }

  public async onNodeAttachToUpstream(
    node: NodeLike,
    attachInfo: AttachInfo
  ): Promise<void> {
    const attachRecord = attachInfo as Record<string, any>;
    const parentKeys = attachRecord.parent_keys ?? attachInfo.parentKeys;
    const targetSystemId =
      attachRecord.target_system_id ?? attachInfo.targetSystemId;
    const targetPhysicalPath =
      attachRecord.target_physical_path ?? attachInfo.targetPhysicalPath;

    if (parentKeys) {
      const validationInput = {
        peerKeys: parentKeys as Array<Record<string, unknown>>,
        nodeLike: node,
      };

      const [isValid, reason] = this._policy.validateAttachSecurityCompatibility
        ? this._policy.validateAttachSecurityCompatibility(validationInput)
        : [true, undefined];

      if (!isValid) {
        logger.error('attach_security_validation_failed', {
          reason,
          parent_system_id: targetSystemId,
          provided_keys_count: Array.isArray(parentKeys)
            ? parentKeys.length
            : undefined,
        });
      } else {
        logger.debug('attach_security_validation_passed', {
          parent_system_id: targetSystemId,
          provided_keys_count: Array.isArray(parentKeys)
            ? parentKeys.length
            : undefined,
        });
      }

      if (this._keyManager) {
        await this._keyManager.addKeys({
          keys: parentKeys,
          physicalPath: targetPhysicalPath,
          systemId: targetSystemId,
          origin: DeliveryOriginType.UPSTREAM,
        });
      } else {
        logger.debug('skipping_parent_keys_no_key_manager');
      }
    } else {
      const requirements = this._policy.requirements();
      if (
        requirements.requireSigningKeyExchange ||
        requirements.requireEncryptionKeyExchange
      ) {
        logger.warning('attach_missing_required_keys', {
          require_signing_keys: requirements.requireSigningKeyExchange,
          require_encryption_keys: requirements.requireEncryptionKeyExchange,
          parent_system_id: targetSystemId,
        });
      }
    }

    const handler =
      (node as { _key_management_handler?: KeyManagementHandler | null })
        ._key_management_handler ?? this._keyManagementHandler;
    if (handler) {
      await handler.retryPendingKeyRequestsAfterAttachment();
    }

    const encryption = this._encryption;
    if (
      encryption &&
      hasNodeListenerMethod(encryption, 'onNodeAttachToUpstream')
    ) {
      await encryption.onNodeAttachToUpstream(node, attachInfo);
    }

    logger.debug('node_attach_security_processed', {
      node_id: node.id,
      parent_system_id: targetSystemId,
      parent_keys_count: Array.isArray(parentKeys) ? parentKeys.length : 0,
    });
  }

  public async onNodeInitialized(node: NodeLike): Promise<void> {
    this._node = node;
    logger.debug('security_manager_node_initialized', {
      node_id: node.id,
      has_node_crypto_provider: Boolean(node.cryptoProvider),
      provider_type: node.cryptoProvider
        ? (node.cryptoProvider.constructor?.name ?? 'unknown')
        : null,
      has_private_key: Boolean(
        node.cryptoProvider &&
          (typeof (node.cryptoProvider as { signingPrivatePem?: unknown })
            .signingPrivatePem === 'string' ||
            typeof (node.cryptoProvider as { signing_private_pem?: unknown })
              .signing_private_pem === 'string')
      ),
    });

    const keyManager = this._keyManager;
    if (keyManager && hasNodeListenerMethod(keyManager, 'onNodeInitialized')) {
      await keyManager.onNodeInitialized(node);
      logger.debug('key_manager_initialized', { node_id: node.id });
    }

    if (
      this._certificateManager &&
      hasNodeListenerMethod(this._certificateManager, 'onNodeInitialized')
    ) {
      await this._certificateManager.onNodeInitialized(node);
    }

    const encryption = this._encryption;
    if (encryption && hasNodeListenerMethod(encryption, 'onNodeInitialized')) {
      await encryption.onNodeInitialized(node);
    }

    logger.debug('node_security_initialization_complete', { node_id: node.id });
  }

  public async onNodeAttachToPeer(
    node: NodeLike,
    attachInfo: AttachInfo,
    connector: FameConnector
  ): Promise<void> {
    const attachRecord = attachInfo as Record<string, any>;
    const peerKeys = attachRecord.parent_keys ?? attachInfo.parentKeys;
    const targetSystemId =
      attachRecord.target_system_id ?? attachInfo.targetSystemId;
    const targetPhysicalPath =
      attachRecord.target_physical_path ?? attachInfo.targetPhysicalPath;

    if (peerKeys && this._keyManager) {
      await this._keyManager.addKeys({
        keys: peerKeys,
        physicalPath: targetPhysicalPath,
        systemId: targetSystemId,
        origin: DeliveryOriginType.PEER,
      });
      logger.debug('peer_keys_added', {
        peer_system_id: targetSystemId,
        peer_keys_count: Array.isArray(peerKeys) ? peerKeys.length : 0,
      });
    } else if (peerKeys) {
      logger.debug('skipping_peer_keys_no_key_manager');
    } else {
      logger.debug('no_peer_keys_provided', {
        peer_system_id: targetSystemId,
      });
    }

    if (
      this._certificateManager &&
      hasNodeListenerMethod(this._certificateManager, 'onNodeAttachToPeer')
    ) {
      await this._certificateManager.onNodeAttachToPeer(
        node,
        attachInfo,
        connector
      );
    }

    const encryption = this._encryption;
    if (encryption && hasNodeListenerMethod(encryption, 'onNodeAttachToPeer')) {
      await encryption.onNodeAttachToPeer(node, attachInfo, connector);
    }
  }

  public async onDeliverLocal(
    node: NodeLike,
    address: FameAddress,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    if (context) {
      context = normalizeContextAliases(context as DeliveryContextWithAliases);
    }
    const localContext = normalizeDeliveryContext(node, context);
    const securityContext = ensureSecurityContext(localContext);
    const wasEncrypted = Boolean(envelope.sec?.enc);

    logger.debug('deliver_local_security_processing', {
      address: String(address),
      envp_id: envelope.id,
      was_encrypted: wasEncrypted,
      has_signature: Boolean(envelope.sec?.sig),
    });

    const frameType = envelope.frame.type;
    const isSystemFrame = new Set([
      'SecureOpen',
      'SecureAccept',
      'SecureClose',
      'DeliveryAck',
      'NodeHeartbeat',
      'NodeHeartbeatAck',
      'KeyAnnounce',
      'KeyRequest',
      'AddressBind',
      'AddressUnbind',
      'AddressBindAck',
      'AddressUnbindAck',
      'CapabilityAdvertise',
      'CapabilityWithdraw',
      'CapabilityAdvertiseAck',
      'CapabilityWithdrawAck',
    ]).has(frameType);

    if (this._policy && !isSystemFrame) {
      const inboundCryptoLevel =
        securityContext.inboundCryptoLevel ??
        this._policy.classifyMessageCryptoLevel(envelope, undefined);

      logger.debug('inbound_crypto_level_classified', {
        envp_id: envelope.id,
        crypto_level: inboundCryptoLevel,
        address: String(address),
      });

      if (
        !this._policy.isInboundCryptoLevelAllowed(
          inboundCryptoLevel,
          envelope,
          undefined
        )
      ) {
        const violationAction = this._policy.getInboundViolationAction(
          inboundCryptoLevel,
          envelope,
          undefined
        );
        logger.warning('inbound_crypto_level_violation', {
          envp_id: envelope.id,
          crypto_level: inboundCryptoLevel,
          action: violationAction,
          address: String(address),
        });

        if (violationAction === SecurityAction.REJECT) {
          logger.error('inbound_message_rejected', {
            envp_id: envelope.id,
            crypto_level: inboundCryptoLevel,
          });
          return null;
        }

        if (violationAction === SecurityAction.NACK) {
          logger.error('inbound_message_nacked', {
            envp_id: envelope.id,
            crypto_level: inboundCryptoLevel,
          });
          await this.sendNack(node, envelope, 'crypto_level_violation');
          return null;
        }
      }

      const hasSignature = Boolean(envelope.sec?.sig);
      if (!hasSignature) {
        const nodeSid = (node as { sid?: string | null | undefined }).sid;
        const envelopeSid = (envelope as { sid?: string | null | undefined })
          .sid;
        const isLocalUnsignedSelfEnvelope =
          localContext.originType === DeliveryOriginType.LOCAL &&
          typeof nodeSid === 'string' &&
          nodeSid.length > 0 &&
          typeof envelopeSid === 'string' &&
          envelopeSid.length > 0 &&
          envelopeSid === nodeSid;

        if (isLocalUnsignedSelfEnvelope) {
          logger.debug('local_message_unsigned_skipping_signature_check', {
            envp_id: envelope.id,
            address: String(address),
          });
        } else if (this._policy.isSignatureRequired(envelope, undefined)) {
          const violationAction = this._policy.getUnsignedViolationAction(
            envelope,
            undefined
          );
          logger.warning('inbound_signature_violation_unsigned', {
            envp_id: envelope.id,
            action: violationAction,
            address: String(address),
          });

          if (violationAction === SecurityAction.REJECT) {
            logger.error('inbound_message_rejected_unsigned', {
              envp_id: envelope.id,
            });
            return null;
          }

          if (violationAction === SecurityAction.NACK) {
            logger.error('inbound_message_nacked_unsigned', {
              envp_id: envelope.id,
            });
            await this.sendNack(node, envelope, 'signature_required');
            return null;
          }
        }
      } else if (
        this._envelopeVerifier &&
        (await this._policy.shouldVerifySignature(envelope, undefined))
      ) {
        try {
          await this._envelopeVerifier.verifyEnvelope(envelope, {
            checkPayload: false,
          });
          logger.debug('inbound_signature_verified', {
            envp_id: envelope.id,
            address: String(address),
          });
        } catch (error) {
          const violationAction =
            this._policy.getInvalidSignatureViolationAction(
              envelope,
              undefined
            );
          logger.warning('inbound_signature_verification_failed', {
            envp_id: envelope.id,
            error: error instanceof Error ? error.message : String(error),
            action: violationAction,
            address: String(address),
          });

          if (violationAction === SecurityAction.REJECT) {
            logger.error('inbound_message_rejected_invalid_signature', {
              envp_id: envelope.id,
            });
            return null;
          }

          if (violationAction === SecurityAction.NACK) {
            logger.error('inbound_message_nacked_invalid_signature', {
              envp_id: envelope.id,
            });
            await this.sendNack(
              node,
              envelope,
              'signature_verification_failed'
            );
            return null;
          }
        }
      }
    }

    if (
      this._envelopeSecurityHandler &&
      (await this._envelopeSecurityHandler.shouldDecryptEnvelope(
        envelope,
        undefined
      ))
    ) {
      envelope = await this._envelopeSecurityHandler.decryptEnvelope(envelope);
      logger.debug('deliver_local_after_decrypt', {
        envp_id: envelope.id,
        frame_type: envelope.frame.type,
      });
    }

    if (
      envelope.frame.type === 'SecureAccept' &&
      this._secureChannelFrameHandler
    ) {
      await this._secureChannelFrameHandler.handleSecureAccept(envelope, null);
      return null;
    }

    if (
      envelope.frame.type === 'SecureOpen' &&
      this._secureChannelFrameHandler
    ) {
      await this._secureChannelFrameHandler.handleSecureOpen(envelope, null);
      return null;
    }

    if (
      envelope.frame.type === 'SecureClose' &&
      this._secureChannelFrameHandler
    ) {
      await this._secureChannelFrameHandler.handleSecureClose(envelope, null);
      return null;
    }

    if (envelope.sec?.sig && isDataFrame(envelope.frame)) {
      if (wasEncrypted) {
        if (!envelope.frame.pd) {
          logger.warning('deliver_local_missing_payload_digest', {
            envp_id: envelope.id,
          });
        }
      } else {
        if (!envelope.frame.pd) {
          throw new Error(
            'DataFrame missing payload digest (pd field) for final delivery'
          );
        }

        const payload = envelope.frame.payload ?? '';
        const payloadString = payload === '' ? '' : canonicalJson(payload);
        const actualDigest = secureDigest(payloadString);

        if (envelope.frame.pd !== actualDigest) {
          logger.error('payload_digest_mismatch_details', {
            expected_pd: envelope.frame.pd,
            actual_digest: actualDigest,
            frame_dict: envelope.frame,
          });
          throw new Error('Payload digest mismatch on final delivery');
        }

        logger.debug('deliver_local_payload_verified', {
          expected_pd: envelope.frame.pd,
          actual_digest: actualDigest,
        });
      }
    }

    logger.debug('deliver_local_security_processing_complete', {
      envp_id: envelope.id,
      address: String(address),
    });
    return envelope;
  }

  public async onDeliver(
    _node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    if (context) {
      context = normalizeContextAliases(context as DeliveryContextWithAliases);
    }
    if (
      context &&
      context.originType !== DeliveryOriginType.LOCAL &&
      this._policy
    ) {
      if (isCriticalFrame(envelope.frame)) {
        const isSigned = Boolean(envelope.sec?.sig);
        if (!isSigned) {
          logger.error('critical_frame_unsigned_rejected', {
            envp_id: envelope.id,
            frame_type: envelope.frame.type,
            reason: 'critical_frames_must_be_signed',
          });
          return null;
        }
      } else if (this._policy.isSignatureRequired(envelope, context)) {
        const isSigned = Boolean(envelope.sec?.sig);
        if (!isSigned) {
          const violationAction = this._policy.getUnsignedViolationAction(
            envelope,
            context
          );
          logger.warning('unsigned_envelope_violation', {
            envp_id: envelope.id,
            frame_type: envelope.frame.type,
            action: violationAction,
          });

          if (
            violationAction === SecurityAction.REJECT ||
            violationAction === SecurityAction.NACK
          ) {
            return null;
          }
        }
      }
    }

    if (
      context &&
      context.originType !== DeliveryOriginType.LOCAL &&
      this._authorizer
    ) {
      try {
        const authResult = await this._authorizer.authorize(
          _node,
          envelope,
          context
        );
        if (!authResult) {
          logger.warning('envelope_authorization_failed', {
            envp_id: envelope.id,
            frame_type: envelope.frame.type,
            origin_type: context.originType ?? 'unknown',
          });
          return null;
        }

        const security = ensureSecurityContext(context);
        let finalAuthResult = authResult;

        const authorizer = this._authorizer;
        if (
          envelope.frame?.type === 'NodeAttach' &&
          hasNodeAttachValidation(authorizer)
        ) {
          try {
            const validated = await authorizer.validateNodeAttachRequest!(
              _node,
              envelope.frame as NodeAttachFrame,
              authResult
            );
            if (validated) {
              finalAuthResult = validated;
            }
          } catch (error) {
            logger.error('node_attach_authorization_validation_failed', {
              envp_id: envelope.id,
              frame_type: envelope.frame.type,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        }

        security.authorization = finalAuthResult;

        logger.debug('envelope_authorization_successful', {
          envp_id: envelope.id,
          frame_type: envelope.frame.type,
          principal: finalAuthResult.principal ?? null,
        });
      } catch (error) {
        logger.error('envelope_authorization_error', {
          envp_id: envelope.id,
          frame_type: envelope.frame.type,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    if (envelope.frame.type === 'KeyAnnounce') {
      if (this._keyFrameHandler && context) {
        await this._keyFrameHandler.acceptKeyAnnounce(envelope, context);
        return null;
      }

      if (this._keyManagementHandler && context) {
        await this._keyManagementHandler.acceptKeyAnnounce(envelope, context);
        return null;
      }

      logger.debug('keyannounce_frame_ignored_no_key_handler', {
        envp_id: envelope.id,
      });
      return envelope;
    }

    if (envelope.frame.type === 'KeyRequest') {
      if (this._keyFrameHandler && context) {
        const handledLocally = await this._keyFrameHandler.acceptKeyRequest(
          envelope,
          context
        );
        if (handledLocally) {
          return null;
        }
      } else if (this._keyManager && context) {
        await this.handleChildKeyRequest(envelope, context);
        return null;
      } else {
        logger.debug('keyrequest_frame_ignored_no_handler', {
          envp_id: envelope.id,
        });
        return envelope;
      }
    }

    if (this._envelopeSecurityHandler) {
      const [processed, shouldContinue] =
        await this._envelopeSecurityHandler.handleEnvelopeSecurity(
          envelope,
          context
        );

      if (!shouldContinue) {
        return null;
      }

      envelope = processed;
    }

    logger.debug('on_deliver_security_processing_complete', {
      envp_id: envelope.id,
    });
    return envelope;
  }

  public async onForwardUpstream(
    _node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    logger.debug('on_forward_upstream_start', { envp_id: envelope.id });

    if (context) {
      context = normalizeContextAliases(context as DeliveryContextWithAliases);
    }

    if (
      context?.originType === DeliveryOriginType.LOCAL &&
      this._envelopeSecurityHandler
    ) {
      const normalizedContext = normalizeDeliveryContext(_node, context);
      const handled =
        await this._envelopeSecurityHandler.handleOutboundSecurity(
          envelope,
          normalizedContext
        );
      if (!handled) {
        logger.debug('on_forward_upstream_queued_for_keys', {
          envp_id: envelope.id,
        });
        return null;
      }
    }

    logger.debug('on_forward_upstream_security_processing_complete', {
      envp_id: envelope.id,
    });
    return envelope;
  }

  public async onForwardToRoute(
    node: NodeLike,
    nextSegment: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    logger.debug('on_forward_to_route_start', {
      envp_id: envelope.id,
      next_segment: nextSegment,
    });

    if (context) {
      context = normalizeContextAliases(context as DeliveryContextWithAliases);
    }

    if (
      context &&
      this._policy &&
      isCriticalFrame(envelope.frame) &&
      !envelope.sec?.sig
    ) {
      if (this._envelopeSecurityHandler) {
        const localContext = createLocalContext(node, context);
        ensureSecurityContext(localContext);
        ensureSecurityContext(localContext);

        const handled =
          await this._envelopeSecurityHandler.handleOutboundSecurity(
            envelope,
            localContext
          );
        if (!handled) {
          logger.warning('critical_frame_forwarding_failed_missing_keys', {
            envp_id: envelope.id,
            frame_type: envelope.frame.type,
            next_segment: nextSegment,
          });
          return null;
        }
      } else {
        logger.error('critical_frame_forwarding_failed_no_security_handler', {
          envp_id: envelope.id,
          frame_type: envelope.frame.type,
          next_segment: nextSegment,
        });
        return null;
      }
    }

    if (
      context?.originType === DeliveryOriginType.LOCAL &&
      this._envelopeSecurityHandler
    ) {
      const normalizedContext = normalizeDeliveryContext(node, context);
      const handled =
        await this._envelopeSecurityHandler.handleOutboundSecurity(
          envelope,
          normalizedContext
        );
      if (!handled) {
        logger.debug('on_forward_to_route_queued_for_keys', {
          envp_id: envelope.id,
          next_segment: nextSegment,
        });
        return null;
      }
    }

    logger.debug('on_forward_to_route_security_processing_complete', {
      envp_id: envelope.id,
      next_segment: nextSegment,
    });
    return envelope;
  }

  public async onForwardToPeer(
    node: NodeLike,
    peerSegment: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    logger.debug('on_forward_to_peer_start', {
      envp_id: envelope.id,
      peer_segment: peerSegment,
    });

    if (context) {
      context = normalizeContextAliases(context as DeliveryContextWithAliases);
    }

    if (
      context &&
      this._policy &&
      isCriticalFrame(envelope.frame) &&
      !envelope.sec?.sig
    ) {
      if (this._envelopeSecurityHandler) {
        const localContext = createLocalContext(node, context);
        ensureSecurityContext(localContext);

        const handled =
          await this._envelopeSecurityHandler.handleOutboundSecurity(
            envelope,
            localContext
          );
        if (!handled) {
          logger.warning('critical_frame_forwarding_failed_missing_keys', {
            envp_id: envelope.id,
            frame_type: envelope.frame.type,
            peer_segment: peerSegment,
          });
          return null;
        }
      } else {
        logger.error('critical_frame_forwarding_failed_no_security_handler', {
          envp_id: envelope.id,
          frame_type: envelope.frame.type,
          peer_segment: peerSegment,
        });
        return null;
      }
    }

    if (
      context?.originType === DeliveryOriginType.LOCAL &&
      this._envelopeSecurityHandler
    ) {
      const handled =
        await this._envelopeSecurityHandler.handleOutboundSecurity(
          envelope,
          context
        );
      if (!handled) {
        logger.debug('on_forward_to_peer_queued_for_keys', {
          envp_id: envelope.id,
          peer_segment: peerSegment,
        });
        return null;
      }
    }

    logger.debug('on_forward_to_peer_security_processing_complete', {
      envp_id: envelope.id,
      peer_segment: peerSegment,
    });
    return envelope;
  }

  public async onForwardToPeers(
    node: NodeLike,
    envelope: FameEnvelope,
    peers?: unknown,
    excludePeers?: unknown,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    logger.debug('on_forward_to_peers_start', {
      envp_id: envelope.id,
      peers,
      exclude_peers: excludePeers,
    });

    if (context) {
      context = normalizeContextAliases(context as DeliveryContextWithAliases);
    }

    if (
      context &&
      this._policy &&
      isCriticalFrame(envelope.frame) &&
      !envelope.sec?.sig
    ) {
      if (this._envelopeSecurityHandler) {
        const localContext = createLocalContext(node, context);

        const handled =
          await this._envelopeSecurityHandler.handleOutboundSecurity(
            envelope,
            localContext
          );
        if (!handled) {
          logger.warning('critical_frame_forwarding_failed_missing_keys', {
            envp_id: envelope.id,
            frame_type: envelope.frame.type,
            peers,
          });
          return null;
        }
      } else {
        logger.error('critical_frame_forwarding_failed_no_security_handler', {
          envp_id: envelope.id,
          frame_type: envelope.frame.type,
          peers,
        });
        return null;
      }
    }

    if (
      context?.originType === DeliveryOriginType.LOCAL &&
      this._envelopeSecurityHandler
    ) {
      const handled =
        await this._envelopeSecurityHandler.handleOutboundSecurity(
          envelope,
          context
        );
      if (!handled) {
        logger.debug('on_forward_to_peers_queued_for_keys', {
          envp_id: envelope.id,
        });
        return null;
      }
    }

    logger.debug('on_forward_to_peers_security_processing_complete', {
      envp_id: envelope.id,
    });
    return envelope;
  }

  public async onEpochChange(_node: NodeLike, epoch: string): Promise<void> {
    logger.debug('handle_epoch_change_security', { epoch });

    if (this._keyManager && this._keyManager.announceKeysToUpstream) {
      await this._keyManager.announceKeysToUpstream();
    } else {
      logger.debug('skipping_key_announcement_no_key_manager');
    }
  }

  public async onNodeStopped(node: NodeLike): Promise<void> {
    logger.debug('stopping_security_components', { node_id: node.id });

    if (this._keyFrameHandler) {
      await this._keyFrameHandler.stop();
      this._keyFrameHandler = null;
      logger.debug('key_frame_handler_stopped');
    }

    if (this._keyManagementHandler) {
      await this._keyManagementHandler.stop();
      this._keyManagementHandler = null;
      logger.debug('key_management_handler_stopped');
    }

    if (
      this._keyManager &&
      hasNodeListenerMethod(this._keyManager, 'onNodeStopped')
    ) {
      await this._keyManager.onNodeStopped(node);
      logger.debug('key_manager_stopped');
    }

    if (
      this._certificateManager &&
      hasNodeListenerMethod(this._certificateManager, 'onNodeStopped')
    ) {
      await this._certificateManager.onNodeStopped(node);
      logger.debug('certificate_manager_stopped');
    }

    if (
      this._encryption &&
      hasNodeListenerMethod(this._encryption, 'onNodeStopped')
    ) {
      await this._encryption.onNodeStopped(node);
      logger.debug('encryption_manager_stopped');
    }

    this._node = null;
    logger.debug('security_manager_node_cleared', { node_id: node.id });
  }

  public async onWelcome(welcomeFrame: NodeWelcomeFrame): Promise<void> {
    if (!this._certificateManager) {
      return;
    }

    try {
      await this._certificateManager.onWelcome?.(welcomeFrame);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('certificate validation failed')
      ) {
        logger.error('child_node_certificate_validation_failed_stopping_node', {
          error: error.message,
          node_id: (welcomeFrame as { system_id?: string }).system_id ?? null,
          assigned_path:
            (welcomeFrame as { assigned_path?: string }).assigned_path ?? null,
          message:
            'Child node cannot proceed due to certificate validation failure',
        });
        throw error;
      }

      logger.warning('certificate_provisioning_error_proceeding_without_cert', {
        error: error instanceof Error ? error.message : String(error),
        node_id: (welcomeFrame as { system_id?: string }).system_id ?? null,
        assigned_path:
          (welcomeFrame as { assigned_path?: string }).assigned_path ?? null,
        exc_info: true,
      });
    }
  }

  public async onHeartbeatReceived(envelope: FameEnvelope): Promise<void> {
    if (envelope.sec?.sig && this._envelopeVerifier) {
      try {
        await this._envelopeVerifier.verifyEnvelope(envelope);
        logger.debug('heartbeat_ack_envelope_verified');
      } catch (error) {
        logger.warning('heartbeat_envelope_verification_failed', {
          envelope_id: envelope.id,
          error: error instanceof Error ? error.message : String(error),
          exc_info: true,
        });
      }
      return;
    }

    if (envelope.sec?.sig && !this._envelopeVerifier) {
      try {
        const requirements =
          (
            this._policy as {
              _requirements?: { verification_required?: boolean };
            }
          )._requirements ?? this._policy.requirements();
        const verificationRequired =
          'verificationRequired' in requirements
            ? requirements.verificationRequired
            : Boolean(requirements.verification_required);
        if (verificationRequired) {
          logger.warning(
            'heartbeat_signature_present_but_no_verifier_policy_requires_verification',
            { envelope_id: envelope.id }
          );
        }
      } catch {
        logger.debug(
          'could_not_determine_verification_policy_allowing_heartbeat',
          {
            envelope_id: envelope.id,
          }
        );
      }
    }
  }

  public async onChildAttach(options: {
    childSystemId: string;
    childKeys?: any;
    nodeLike: NodeLike;
    originType?: any;
    assignedPath?: string;
    oldAssignedPath?: string;
    isRebind?: boolean;
  }): Promise<void> {
    const {
      childSystemId,
      childKeys,
      nodeLike,
      originType,
      assignedPath,
      oldAssignedPath,
      isRebind = false,
    } = options;

    const ourKeys = this._getKeysToProvide();

    if (isRebind && oldAssignedPath && this._keyManager) {
      try {
        const removedCount =
          await this._keyManager.removeKeysForPath(oldAssignedPath);
        logger.debug('removed_stale_keys_on_rebind', {
          system_id: childSystemId,
          old_path: oldAssignedPath,
          removed_count: removedCount,
        });
      } catch (error) {
        logger.warning('failed_to_remove_stale_keys_on_rebind', {
          system_id: childSystemId,
          old_path: oldAssignedPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const sentinelPolicy = nodeLike.securityManager?.policy ?? null;
    if (sentinelPolicy) {
      if (childKeys) {
        const childValidationOptions: {
          peerKeys?: Array<Record<string, unknown>>;
          nodeLike?: NodeLike;
        } = { nodeLike };
        if (Array.isArray(childKeys)) {
          childValidationOptions.peerKeys = childKeys as Array<
            Record<string, unknown>
          >;
        }

        const [validChildKeys, reason] =
          sentinelPolicy.validateAttachSecurityCompatibility
            ? sentinelPolicy.validateAttachSecurityCompatibility(
                childValidationOptions
              )
            : [true, undefined];

        if (!validChildKeys) {
          logger.warning('attach_child_security_validation_failed', {
            reason,
            child_system_id: childSystemId,
            child_keys_count: childKeys.length ?? 0,
          });
        } else {
          logger.debug('attach_child_security_validation_passed', {
            child_system_id: childSystemId,
            child_keys_count: childKeys.length ?? 0,
          });
        }
      }

      const ourValidationOptions: {
        peerKeys?: Array<Record<string, unknown>>;
        nodeLike?: NodeLike;
      } = { nodeLike };
      if (ourKeys) {
        ourValidationOptions.peerKeys = ourKeys;
      }

      const [ourKeysValid, ourReason] =
        sentinelPolicy.validateAttachSecurityCompatibility
          ? sentinelPolicy.validateAttachSecurityCompatibility(
              ourValidationOptions
            )
          : [true, undefined];

      if (!ourKeysValid) {
        logger.warning('attach_our_security_validation_warning', {
          reason: ourReason,
          child_system_id: childSystemId,
          our_keys_count: ourKeys?.length ?? 0,
        });
      } else {
        logger.debug('attach_our_security_validation_passed', {
          child_system_id: childSystemId,
          our_keys_count: ourKeys?.length ?? 0,
        });
      }

      const requirements = sentinelPolicy.requirements();
      if (ourKeys && ourKeys.length > 0) {
        const hasSigningKey = ourKeys.some((key) => {
          const use = key.use;
          return (
            (use === 'sig' || use === undefined || use === null) &&
            key.kty === 'OKP' &&
            key.crv === 'Ed25519'
          );
        });
        const hasEncryptionKey = ourKeys.some((key) => {
          const use = key.use;
          return (
            (use === 'enc' || use === undefined || use === null) &&
            key.kty === 'OKP' &&
            key.crv === 'X25519'
          );
        });

        if (requirements.requireSigningKeyExchange && !hasSigningKey) {
          logger.warning('attach_missing_signing_key', {
            child_system_id: childSystemId,
            reason:
              'Our policy requires signing but we are not providing signing keys',
          });
        }

        if (requirements.requireEncryptionKeyExchange && !hasEncryptionKey) {
          logger.warning('attach_missing_encryption_key', {
            child_system_id: childSystemId,
            reason:
              'Our policy requires encryption but we are not providing encryption keys',
          });
        }
      } else if (
        requirements.requireSigningKeyExchange ||
        requirements.requireEncryptionKeyExchange
      ) {
        logger.warning('attach_no_keys_provided', {
          child_system_id: childSystemId,
          require_signing: requirements.requireSigningKeyExchange,
          require_encryption: requirements.requireEncryptionKeyExchange,
        });
      }
    }

    if (childKeys && this._keyManager && assignedPath && originType) {
      try {
        await this._keyManager.addKeys({
          keys: childKeys,
          physicalPath: assignedPath,
          origin: originType,
          systemId: childSystemId,
        });
        logger.debug('added_child_attach_keys', {
          child_system_id: childSystemId,
          assigned_path: assignedPath,
          keys_count: childKeys.length ?? 0,
        });
      } catch (error) {
        if (error instanceof FameTransportClose) {
          logger.error('failed_to_add_attach_keys_will_retry_on_epoch_change', {
            parent_id: childSystemId,
            trace_id: currentTraceId(),
            exc_info: true,
          });
        } else {
          logger.error('failed_to_add_attach_keys', {
            child_system_id: childSystemId,
            assigned_path: assignedPath,
            error: error instanceof Error ? error.message : String(error),
            exc_info: true,
          });
        }
      }
    }
  }

  private async handleChildKeyRequest(
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ): Promise<void> {
    if (!this._keyManager) {
      throw new Error('KeyManager must be set for KeyRequest handling');
    }

    const frame = envelope.frame as KeyRequestFrame;
    const originSid = context.fromSystemId ?? null;
    if (!originSid) {
      logger.warning('missing_origin_sid_for_key_request', {
        envp_id: envelope.id,
      });
      return;
    }

    logger.debug('handling_key_request_for_child_node', {
      address: frame.address ? String(frame.address) : null,
      kid: frame.kid ?? null,
      corr_id: envelope.corrId ?? null,
      origin_sid: originSid,
    });

    if (frame.kid) {
      const requestOptions: HandleKeyRequestOptions = {
        kid: frame.kid,
        fromSegment: originSid,
        origin: context.originType ?? DeliveryOriginType.LOCAL,
      };
      if (frame.physicalPath !== undefined) {
        requestOptions.physicalPath = frame.physicalPath;
      }
      if (envelope.corrId !== undefined) {
        requestOptions.correlationId = envelope.corrId;
      }
      if (envelope.sid !== undefined) {
        requestOptions.originalClientSid = envelope.sid;
      }

      logger.debug('child_node_forwarding_key_request', {
        kid: frame.kid,
        origin_sid: originSid,
        correlation_id: envelope.corrId ?? null,
      });

      await this._keyManager.handleKeyRequest(requestOptions);
      return;
    }

    if (frame.address) {
      try {
        const cryptoProvider = this.resolveCryptoProvider();
        if (!cryptoProvider) {
          logger.debug('crypto_provider_key_lookup_failed', {
            error: 'no_crypto_provider_available',
            envp_id: envelope.id,
          });
        }

        if (cryptoProvider?.encryptionKeyId) {
          const requestOptions: HandleKeyRequestOptions = {
            kid: cryptoProvider.encryptionKeyId,
            fromSegment: originSid,
            origin: context.originType ?? DeliveryOriginType.LOCAL,
          };
          if (envelope.corrId !== undefined) {
            requestOptions.correlationId = envelope.corrId;
          }
          if (envelope.sid !== undefined) {
            requestOptions.originalClientSid = envelope.sid;
          }

          logger.debug('child_node_responding_with_own_encryption_key_id', {
            key_id: cryptoProvider.encryptionKeyId,
            requested_address: frame.address ? String(frame.address) : null,
            envp_id: envelope.id,
          });

          await this._keyManager.handleKeyRequest(requestOptions);
          return;
        }

        if (cryptoProvider?.signatureKeyId) {
          const requestOptions: HandleKeyRequestOptions = {
            kid: cryptoProvider.signatureKeyId,
            fromSegment: originSid,
            origin: context.originType ?? DeliveryOriginType.LOCAL,
          };
          if (envelope.corrId !== undefined) {
            requestOptions.correlationId = envelope.corrId;
          }
          if (envelope.sid !== undefined) {
            requestOptions.originalClientSid = envelope.sid;
          }

          logger.debug('child_node_responding_with_own_signature_key_id', {
            key_id: cryptoProvider.signatureKeyId,
            requested_address: frame.address ? String(frame.address) : null,
            envp_id: envelope.id,
          });

          await this._keyManager.handleKeyRequest(requestOptions);
          return;
        }
      } catch (error) {
        logger.debug('crypto_provider_key_lookup_failed', {
          error: error instanceof Error ? error.message : String(error),
          envp_id: envelope.id,
        });
      }

      logger.debug('child_node_cannot_resolve_address_key_request', {
        address: frame.address,
        reason: 'no_crypto_provider_keys_found',
        envp_id: envelope.id,
      });
      return;
    }

    logger.warning('key_request_missing_both_kid_and_address', {
      envp_id: envelope.id,
    });
  }

  private _getKeyAnnounceHandler(): (
    envelope: FameEnvelope,
    context: FameDeliveryContext
  ) => Promise<void> {
    if (this._keyManagementHandler) {
      return (envelope, context) =>
        this._keyManagementHandler!.acceptKeyAnnounce(envelope, context);
    }

    return async (): Promise<void> => {
      // no-op when key management handler not available
    };
  }

  private _getKeysToProvide(): Array<Record<string, unknown>> | null {
    if (!this._envelopeSigner) {
      logger.debug('no_keys_provided_no_crypto_components');
      return null;
    }

    try {
      const cryptoProvider = this.resolveCryptoProvider();
      if (!cryptoProvider) {
        return null;
      }

      const keys: Array<Record<string, unknown>> = [];
      const nodeJwk = cryptoProvider.nodeJwk?.();
      if (nodeJwk) {
        keys.push(nodeJwk as Record<string, unknown>);
      }

      const jwks = cryptoProvider.getJwks?.();
      if (jwks?.keys) {
        for (const jwk of jwks.keys as Array<Record<string, unknown>>) {
          if (
            nodeJwk &&
            jwk.kid === (nodeJwk as Record<string, unknown>).kid &&
            jwk.use !== 'enc'
          ) {
            continue;
          }
          keys.push(jwk as Record<string, unknown>);
        }
      }

      return keys.length > 0 ? keys : null;
    } catch {
      return null;
    }
  }

  private resolveCryptoProvider(): CryptoProvider | null {
    if (this._node) {
      const provider = this._node.cryptoProvider ?? null;
      logger.debug('resolve_provider_from_node', {
        node_id: this._node.id,
        has_provider: Boolean(provider),
      });
      return provider;
    }

    logger.debug('resolve_provider_without_node_context');
    return null;
  }

  private async sendNack(
    node: NodeLike,
    originalEnv: FameEnvelope,
    reason: string
  ): Promise<void> {
    const frameType = originalEnv.frame?.type;
    if (
      frameType === 'CreditUpdate' ||
      frameType === 'NodeHeartbeat' ||
      frameType === 'NodeHeartbeatAck'
    ) {
      logger.debug('nack_skipped_for_control_frame', {
        envp_id: originalEnv.id,
        frame_type: frameType,
        reason,
      });
      return;
    }

    if (!originalEnv.replyTo) {
      logger.debug('nack_no_destination', { envp_id: originalEnv.id });
      return;
    }

    const frame = {
      type: 'DeliveryAck',
      ok: false,
      refId: originalEnv.id,
      code: reason,
    } as const;

    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      to: originalEnv.replyTo,
    };
    if (originalEnv.traceId !== undefined) {
      envelopeOptions.traceId = originalEnv.traceId;
    }
    if (originalEnv.corrId !== undefined) {
      envelopeOptions.corrId = originalEnv.corrId;
    }

    const envelope = node.envelopeFactory.createEnvelope(envelopeOptions);

    await node.deliver(envelope, {
      originType: DeliveryOriginType.LOCAL,
      fromSystemId: node.id,
      expectedResponseType: FameResponseType.NONE,
    });
  }

  private getSpawner(
    target: unknown
  ):
    | ((
        task: () => Promise<void>,
        options?: { name?: string }
      ) => Promise<unknown> | unknown)
    | null {
    const candidate = (target as SpawnLike | undefined)?.spawn;
    if (typeof candidate === 'function') {
      return candidate.bind(target as object);
    }
    return null;
  }

  private isRoutingNode(node: NodeLike): node is RoutingNodeLike {
    return typeof (node as RoutingNodeLike).forwardToRoute === 'function';
  }
}
