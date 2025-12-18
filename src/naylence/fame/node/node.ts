import {
  DEFAULT_INVOKE_TIMEOUT_MILLIS,
  DeliveryOriginType,
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
  createChannelMessage,
  formatAddress,
  localDeliveryContext,
  parseAddress,
} from '@naylence/core';
import type {
  DeliveryAckFrame,
  FameConnector,
  FameEnvelopeHandler,
  FameRPCHandler,
} from '@naylence/core';
import { generateId } from '@naylence/core';
import { secureDigest } from '../util/util.js';
import type { DeliveryPolicy } from '../delivery/delivery-policy.js';
import type { SecurityManager } from '../security/security-manager.js';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';
import type { AdmissionClient } from './admission/admission-client.js';
import type { ConnectionRetryPolicy } from './connection-retry-policy.js';
import type { NodeEventListener } from './node-event-listener.js';
import type { StorageProvider, KeyValueStore } from '../storage/index.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage.js';
import { NodeEnvelopeFactory } from './node-envelope-factory.js';
import type { EnvelopeFactory } from '@naylence/core';
import { BindingManager } from './binding-manager.js';
import type {
  BindingStoreEntry,
  BindingManagerOptions,
} from './binding-manager.js';
import { EnvelopeListenerManager } from './envelope-listener-manager.js';
import { DefaultDeliveryTracker } from '../delivery/default-delivery-tracker.js';
import type { RetryPolicy } from '../delivery/retry-policy.js';
import type { RetryEventHandler } from '../delivery/retry-event-handler.js';
import type { NodeLike } from './node-like.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { getLogger } from '../util/logging.js';
import type {
  NodeAttachClient,
  AttachInfo,
} from './admission/node-attach-client.js';
import type { NodeWelcomeFrame } from '@naylence/core';
import { RootSessionManager } from './root-session-manager.js';
import { UpstreamSessionManager } from './upstream-session-manager.js';
import type { SessionManager } from './session-manager.js';
import { NoopAdmissionClient } from './admission/noop-admission-client.js';
import { NodeMetaRecord, NODE_META_NAMESPACE } from './node-meta.js';
import type { TransportListener } from '../connector/transport-listener.js';
import type { ServiceManager } from '../service/service-manager.js';
import { DefaultServiceManager } from '../service/default-service-manager.js';

const SYSTEM_INBOX = '__sys__';

const logger = getLogger('naylence.fame.node.node');

function isSnakeCase(name: string): boolean {
  return name.includes('_');
}

function camelToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) =>
    char.toUpperCase()
  );
}

function getCandidateNames(eventName: string): string[] {
  const candidates = new Set<string>();
  candidates.add(eventName);
  if (isSnakeCase(eventName)) {
    candidates.add(snakeToCamel(eventName));
  } else {
    candidates.add(camelToSnake(eventName));
  }
  return Array.from(candidates);
}

function resolveListenerMethod(
  listener: NodeEventListener,
  eventName: string
): ((...args: any[]) => any) | undefined {
  for (const candidate of getCandidateNames(eventName)) {
    const handler = (listener as any)[candidate];
    if (typeof handler === 'function') {
      return handler.bind(listener);
    }
  }
  return undefined;
}

class DefaultRetryHandler implements RetryEventHandler {
  constructor(
    private readonly deliveryFn: (
      envelope: FameEnvelope,
      context?: FameDeliveryContext
    ) => Promise<unknown>
  ) {}

  async onRetryNeeded(
    envelope: FameEnvelope,
    _attempt: number,
    _nextDelayMs: number,
    context?: FameDeliveryContext
  ): Promise<void> {
    await this.deliveryFn(envelope, context);
  }
}

export interface FameNodeOptions {
  systemId?: string;
  physicalPath?: string;
  hasParent?: boolean;
  acceptedLogicals?: string[];
  storageProvider?: StorageProvider;
  envelopeFactory?: EnvelopeFactory;
  deliveryPolicy?: DeliveryPolicy | null;
  eventListeners?: NodeEventListener[];
  admissionClient?: AdmissionClient | null;
  attachClient?: NodeAttachClient | null;
  requestedLogicals?: string[];
  securityManager?: SecurityManager | null;
  publicUrl?: string | null;
  deliveryTracker?: DefaultDeliveryTracker;
  bindingStore?: KeyValueStore<BindingStoreEntry> | null;
  serviceManager?: ServiceManager | null;
  serviceCapabilityMap?:
    | Map<string, FameAddress>
    | Record<string, FameAddress>
    | null;
  servicePollTimeoutMs?: number | null;
  defaultServiceConfigs?: Array<Record<string, unknown>>;
  nodeMetaStore?: KeyValueStore<NodeMetaRecord> | null;
  transportListeners?: TransportListener[];
  cryptoProvider?: CryptoProvider | null;
  connectionRetryPolicy?: ConnectionRetryPolicy | null;
}

type FameNodeOptionsInput = FameNodeOptions & Record<string, unknown>;

function resolveOption<T>(
  options: FameNodeOptionsInput,
  primary: keyof FameNodeOptions,
  ...aliases: string[]
): T | undefined {
  const primaryValue = options[primary];
  if (primaryValue !== undefined) {
    return primaryValue as T;
  }

  for (const alias of aliases) {
    if (alias in options) {
      const aliasValue = options[alias];
      if (aliasValue !== undefined) {
        return aliasValue as T;
      }
    }
  }

  return undefined;
}

function resolveBooleanOption(
  options: FameNodeOptionsInput,
  primary: keyof FameNodeOptions,
  ...aliases: string[]
): boolean | undefined {
  const value = resolveOption<unknown>(options, primary, ...aliases);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function resolveStringOption(
  options: FameNodeOptionsInput,
  primary: keyof FameNodeOptions,
  ...aliases: string[]
): string | null | undefined {
  const value = resolveOption<unknown>(options, primary, ...aliases);
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'string') {
    return value as string | null;
  }
  return undefined;
}

function resolveNumberOption(
  options: FameNodeOptionsInput,
  primary: keyof FameNodeOptions,
  ...aliases: string[]
): number | null | undefined {
  const value = resolveOption<unknown>(options, primary, ...aliases);
  if (value === undefined || value === null) {
    return value as number | null | undefined;
  }
  if (typeof value === 'number') {
    return value;
  }
  return undefined;
}

function resolveArrayOption<T>(
  options: FameNodeOptionsInput,
  primary: keyof FameNodeOptions,
  ...aliases: string[]
): T[] | undefined {
  const value = resolveOption<unknown>(options, primary, ...aliases);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value as T[];
  }
  return undefined;
}

function resolveStringArrayOption(
  options: FameNodeOptionsInput,
  primary: keyof FameNodeOptions,
  ...aliases: string[]
): string[] | undefined {
  const value = resolveArrayOption<string>(options, primary, ...aliases);
  if (!value) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function sortListeners(listeners: NodeEventListener[]): NodeEventListener[] {
  return [...listeners].sort((a, b) => a.priority - b.priority);
}

export class FameNode extends TaskSpawner implements NodeLike {
  private _provisionalId: string;
  private _confirmedId: string | null = null;
  private _sid: string | null;
  private _physicalPath: string;
  private _acceptedLogicals: Set<string>;
  private readonly _hasParent: boolean;
  private readonly _storageProvider: StorageProvider;
  private readonly _bindingManager: BindingManager;
  private readonly _envelopeListenerManager: EnvelopeListenerManager;
  private readonly _serviceManager: ServiceManager;
  private readonly _deliveryTracker: DefaultDeliveryTracker;
  private readonly _eventListeners: NodeEventListener[];
  private readonly _envelopeFactory: EnvelopeFactory;
  private readonly _deliveryPolicy: DeliveryPolicy | null;
  private readonly _admissionClient: AdmissionClient | null;
  private readonly _attachClient: NodeAttachClient | null;
  private readonly _requestedLogicals: string[];
  private readonly _securityManager: SecurityManager | null;
  private readonly _publicUrl: string | null;
  private readonly _cryptoProvider: CryptoProvider;
  private readonly _nodeMetaStorePromise: Promise<
    KeyValueStore<NodeMetaRecord>
  >;
  private readonly _transportListeners: TransportListener[];
  private _defaultBindingPath: string;
  private _sessionManager: SessionManager | null = null;
  private _upstreamConnector: FameConnector | null = null;
  private _isStarted = false;
  private _lastHeartbeatAt: number | null = null;
  private _handshakeCompleted: boolean;
  private _welcomeExpiresAt: string | null;
  private _attachExpiresAt: Date | null;
  private readonly _connectionRetryPolicy: ConnectionRetryPolicy | null;

  constructor(options: FameNodeOptionsInput = {}) {
    super();

    const systemIdOption = resolveStringOption(
      options,
      'systemId',
      'system_id'
    );
    this._provisionalId = systemIdOption ?? generateId();

    const physicalPathOption = resolveStringOption(
      options,
      'physicalPath',
      'physical_path'
    );
    this._physicalPath = physicalPathOption ?? `/${this._provisionalId}`;

    const hasParentOption = resolveBooleanOption(
      options,
      'hasParent',
      'has_parent'
    );
    this._hasParent = hasParentOption ?? false;

    const storageProviderOption = resolveOption<StorageProvider | null>(
      options,
      'storageProvider',
      'storage_provider'
    );
    this._storageProvider =
      storageProviderOption ?? new InMemoryStorageProvider();

    const acceptedLogicalsOption =
      resolveStringArrayOption(
        options,
        'acceptedLogicals',
        'accepted_logicals'
      ) ?? [];
    this._acceptedLogicals = new Set(acceptedLogicalsOption);

    const deliveryPolicyOption = resolveOption<DeliveryPolicy | null>(
      options,
      'deliveryPolicy',
      'delivery_policy'
    );
    this._deliveryPolicy = deliveryPolicyOption ?? null;

    const connectionRetryPolicyOption = resolveOption<ConnectionRetryPolicy | null>(
      options,
      'connectionRetryPolicy',
      'connection_retry_policy'
    );
    this._connectionRetryPolicy = connectionRetryPolicyOption ?? null;

    const admissionClientOption = resolveOption<AdmissionClient | null>(
      options,
      'admissionClient',
      'admission_client'
    );
    this._admissionClient = admissionClientOption ?? null;

    const attachClientOption = resolveOption<NodeAttachClient | null>(
      options,
      'attachClient',
      'attach_client'
    );
    this._attachClient = attachClientOption ?? null;

    const requestedLogicalsOption =
      resolveStringArrayOption(
        options,
        'requestedLogicals',
        'requested_logicals'
      ) ?? [];
    this._requestedLogicals = [...requestedLogicalsOption];

    const securityManagerOption = resolveOption<SecurityManager | null>(
      options,
      'securityManager',
      'security_manager'
    );
    this._securityManager = securityManagerOption ?? null;

    const publicUrlOption = resolveStringOption(
      options,
      'publicUrl',
      'public_url'
    );
    this._publicUrl = publicUrlOption ?? null;

    const cryptoProviderOption = resolveOption<CryptoProvider | null>(
      options,
      'cryptoProvider',
      'crypto_provider'
    );
    const fallbackCryptoProvider: CryptoProvider = {};
    this._cryptoProvider = cryptoProviderOption ?? fallbackCryptoProvider;

    const envelopeFactoryOption = resolveOption<EnvelopeFactory | null>(
      options,
      'envelopeFactory',
      'envelope_factory'
    );
    const envelopeFactory =
      envelopeFactoryOption ?? new NodeEnvelopeFactory(() => this.sid ?? '');
    this._envelopeFactory = envelopeFactory;

    const deliveryTrackerOption = resolveOption<DefaultDeliveryTracker | null>(
      options,
      'deliveryTracker',
      'delivery_tracker'
    );
    const tracker =
      deliveryTrackerOption ??
      new DefaultDeliveryTracker(this._storageProvider);
    this._deliveryTracker = tracker;

    const nodeMetaStoreOption =
      resolveOption<KeyValueStore<NodeMetaRecord> | null>(
        options,
        'nodeMetaStore',
        'node_meta_store'
      );
    this._nodeMetaStorePromise = nodeMetaStoreOption
      ? Promise.resolve(nodeMetaStoreOption)
      : this._storageProvider.getKeyValueStore(
          NodeMetaRecord,
          NODE_META_NAMESPACE
        );

    const transportListenersResolved =
      resolveArrayOption<TransportListener>(
        options,
        'transportListeners',
        'transport_listeners'
      ) ?? [];
    const transportListeners = [...transportListenersResolved];
    this._transportListeners = transportListeners;

    const listenersResolved =
      resolveArrayOption<NodeEventListener>(
        options,
        'eventListeners',
        'event_listeners'
      ) ?? [];
    const listeners: NodeEventListener[] = [...listenersResolved];

    if (this._securityManager && !listeners.includes(this._securityManager)) {
      listeners.push(this._securityManager);
    }

    for (const listener of transportListeners) {
      if (!listeners.includes(listener)) {
        listeners.push(listener);
      }
    }

    if (!listeners.includes(tracker)) {
      listeners.push(tracker);
    }

    this._eventListeners = sortListeners(listeners);

    const bindingStoreOption =
      resolveOption<KeyValueStore<BindingStoreEntry> | null>(
        options,
        'bindingStore',
        'binding_store'
      );

    const bindingManagerOptions: BindingManagerOptions = {
      hasUpstream: this._hasParent,
      getId: () => this.id,
      getPhysicalPath: () => this._physicalPath,
      getAcceptedLogicals: () => this._acceptedLogicals,
      forwardUpstream: (
        envelope: FameEnvelope,
        context?: FameDeliveryContext
      ) => this.forwardUpstream(envelope, context),
      envelopeFactory: this._envelopeFactory,
      deliveryTracker: this._deliveryTracker,
      getEncryptionKeyId: () =>
        this._securityManager?.getEncryptionKeyId() ?? null,
      ...(bindingStoreOption ? { bindingStore: bindingStoreOption } : {}),
    };

    this._bindingManager = new BindingManager(bindingManagerOptions);
    (
      this as unknown as { _binding_manager?: BindingManager }
    )._binding_manager = this._bindingManager;

    this._envelopeListenerManager = new EnvelopeListenerManager({
      bindingManager: this._bindingManager,
      nodeLike: this,
      envelopeFactory: this._envelopeFactory,
      deliveryTracker: this._deliveryTracker,
    });

    const serviceManagerOption = resolveOption<ServiceManager | null>(
      options,
      'serviceManager',
      'service_manager'
    );

    const defaultServiceConfigs =
      resolveArrayOption<Record<string, unknown>>(
        options,
        'defaultServiceConfigs',
        'default_service_configs',
        'service_configs'
      ) ?? [];

    const serviceCapabilityMapOption = resolveOption<
      Map<string, FameAddress> | Record<string, FameAddress> | null
    >(options, 'serviceCapabilityMap', 'service_capability_map');

    const servicePollTimeoutOption = resolveNumberOption(
      options,
      'servicePollTimeoutMs',
      'service_poll_timeout_ms'
    );

    const serviceManager =
      serviceManagerOption ??
      new DefaultServiceManager({
        invoke: (
          targetAddr: FameAddress,
          method: string,
          params: Record<string, unknown>,
          timeoutMs?: number | null
        ) =>
          this.invoke(
            targetAddr,
            method,
            params,
            timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS
          ),
        serve: (
          serviceName: string,
          handler: FameEnvelopeHandler,
          serveOptions?: Parameters<EnvelopeListenerManager['listen']>[2]
        ) =>
          this._envelopeListenerManager.listen(
            serviceName,
            handler,
            serveOptions ?? {}
          ),
        serveRpc: (
          serviceName: string,
          handler: FameRPCHandler,
          serveOptions?: Parameters<EnvelopeListenerManager['listenRpc']>[2]
        ) =>
          this._envelopeListenerManager.listenRpc(
            serviceName,
            handler,
            serveOptions ?? {}
          ),
        capabilityMap: serviceCapabilityMapOption ?? undefined,
        pollTimeoutMs: servicePollTimeoutOption ?? null,
        defaultServiceConfigs,
        node: this,
      });

    this._serviceManager = serviceManager;

    this._defaultBindingPath = this._physicalPath;

    const physicalPathProvided =
      options.physicalPath !== undefined ||
      options['physical_path'] !== undefined;

    this._sid =
      this._hasParent && !physicalPathProvided
        ? null
        : this.computeSid(this._physicalPath);
    this._handshakeCompleted = !this._hasParent;
    this._welcomeExpiresAt = null;
    this._attachExpiresAt = null;
  }

  private async initializeSessionManager(): Promise<void> {
    if (this._sessionManager) {
      return;
    }

    if (this._hasParent) {
      await this.initializeUpstreamSessionManager();
    } else {
      await this.initializeRootSessionManager();
    }
  }

  private async initializeRootSessionManager(): Promise<void> {
    const admissionClient =
      this._admissionClient ??
      new NoopAdmissionClient({ systemId: this._provisionalId });

    const manager = new RootSessionManager({
      node: this,
      admissionClient,
      requestedLogicals: [...this._requestedLogicals],
      onWelcome: (frame) => this.handleWelcome(frame),
      onEpochChange: (epoch) => this.handleEpochChange(epoch),
    });

    this._sessionManager = manager;
    await manager.start();
  }

  private async initializeUpstreamSessionManager(): Promise<void> {
    if (!this._attachClient) {
      throw new Error('Attach client is required for upstream nodes');
    }

    if (!this._admissionClient) {
      throw new Error('Admission client is required for upstream nodes');
    }

    const manager = new UpstreamSessionManager({
      node: this,
      attachClient: this._attachClient,
      requestedLogicals: [...this._requestedLogicals],
      outboundOriginType: DeliveryOriginType.DOWNSTREAM,
      inboundOriginType: DeliveryOriginType.UPSTREAM,
      inboundHandler: (envelope: FameEnvelope, context?: FameDeliveryContext) =>
        this.handleInboundFromUpstream(envelope, context),
      onWelcome: (frame) => this.handleWelcome(frame),
      onAttach: (info, connector) => this.handleAttach(info, connector),
      onEpochChange: (epoch) => this.handleEpochChange(epoch),
      admissionClient: this._admissionClient,
      retryPolicy: this._connectionRetryPolicy,
    });

    this._sessionManager = manager;
    await manager.start();
  }

  private async handleInboundFromUpstream(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<null> {
    await this.deliver(envelope, context);
    return null;
  }

  private confirmIdentity(systemId: string, source: string): void {
    if (this._confirmedId) {
      if (this._confirmedId !== systemId) {
        logger.error('node_identity_mismatch', {
          current_id: this._confirmedId,
          new_id: systemId,
          source,
        });
        throw new Error(
          `Node identity mismatch in ${source}: expected ${this._confirmedId}, got ${systemId}`
        );
      }
      return;
    }

    const isReassignment = this._provisionalId !== systemId;
    this._confirmedId = systemId;

    if (isReassignment) {
      logger.debug('node_identity_reassigned', {
        system_id: systemId,
        previous_id: this._provisionalId,
        source,
      });
    } else {
      logger.debug('node_identity_confirmed', {
        system_id: systemId,
        source,
      });
    }
  }

  private async handleWelcome(welcome: NodeWelcomeFrame): Promise<void> {
    if (welcome.systemId) {
      this.confirmIdentity(welcome.systemId, 'handleWelcome');
    }

    if (welcome.acceptedLogicals) {
      this._acceptedLogicals = new Set(welcome.acceptedLogicals);
    }

    this._welcomeExpiresAt = welcome.expiresAt ?? null;

    if (!this._hasParent) {
      if (welcome.assignedPath) {
        this._physicalPath = welcome.assignedPath;
      } else if (welcome.systemId) {
        this._physicalPath = `/${welcome.systemId}`;
      }

      this._defaultBindingPath = this._physicalPath;
      this._sid = this.computeSid(this._physicalPath);
      this._upstreamConnector = null;
      this._handshakeCompleted = true;
    }

    await this.dispatchEvent('onWelcome', welcome);
  }

  private async handleAttach(
    info: AttachInfo,
    connector: FameConnector
  ): Promise<void> {
    this.confirmIdentity(info.systemId, 'handleAttach');
    this._physicalPath =
      info.assignedPath ?? info.targetPhysicalPath ?? this._physicalPath;
    this._upstreamConnector = connector;

    if (info.acceptedLogicals) {
      this._acceptedLogicals = new Set(info.acceptedLogicals);
    }

    this._attachExpiresAt = info.attachExpiresAt ?? null;
    this._handshakeCompleted = true;

    if (this._physicalPath) {
      this._defaultBindingPath = this._physicalPath;
      this._sid = this.computeSid(this._physicalPath);
    }

    await this.dispatchEvent('onNodeAttachToUpstream', this, info);
  }

  private async handleEpochChange(epoch: string): Promise<void> {
    await this._bindingManager.rebindAddressesUpstream();
    await this._bindingManager.readvertiseCapabilitiesUpstream();
    await this.dispatchEvent('onEpochChange', this, epoch);
  }

  private async stopSessionManager(): Promise<void> {
    const manager = this._sessionManager;
    if (!manager) {
      return;
    }

    try {
      await manager.stop();
    } finally {
      this._sessionManager = null;
      this._upstreamConnector = null;
    }
  }

  private async handleSystemFrame(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const frameType = envelope.frame?.type;
    if (!frameType) {
      return;
    }

    if (frameType === 'NodeHeartbeat') {
      logger.debug('received_heartbeat_frame', {
        envelopeId: envelope.id,
        corrId: envelope.corrId ?? null,
      });
      this._lastHeartbeatAt = Date.now();
      await this.dispatchEvent('onHeartbeatReceived', envelope);
      return;
    }

    if (frameType === 'DeliveryAck') {
      await this.handleDeliveryAck(envelope, context);
      return;
    }

    logger.debug('unhandled_system_frame', {
      envelopeId: envelope.id,
      frameType,
    });
  }

  private async handleDeliveryAck(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const frame = envelope.frame as DeliveryAckFrame | undefined;
    if (!frame || frame.type !== 'DeliveryAck') {
      return;
    }

    await this._deliveryTracker.onEnvelopeDelivered(
      SYSTEM_INBOX,
      envelope,
      context
    );

    if (frame.ok !== false) {
      logger.debug('delivery_ack_received', {
        envelopeId: envelope.id,
        corrId: envelope.corrId ?? null,
      });
      return;
    }

    logger.warning('delivery_nack_received', {
      envelopeId: envelope.id,
      corrId: envelope.corrId ?? null,
      code: frame.code ?? null,
      reason: frame.reason ?? null,
      fromSystemId: context?.fromSystemId ?? null,
    });

    await this.onDeliveryNack(frame, envelope, context);
  }

  protected async onDeliveryNack(
    frame: DeliveryAckFrame,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<void> {
    logger.debug('delivery_nack_processed', {
      envelopeId: envelope.id,
      code: frame.code ?? null,
      reason: frame.reason ?? null,
    });
  }

  get id(): string {
    if (!this._confirmedId) {
      throw new Error(
        'Node ID has not been confirmed yet. Use provisionalId for bootstrapping.'
      );
    }
    return this._confirmedId;
  }

  get provisionalId(): string {
    return this._provisionalId;
  }

  get sid(): string | null {
    return this._sid;
  }

  get physicalPath(): string {
    return this._physicalPath;
  }

  get acceptedLogicals(): Set<string> {
    return this._acceptedLogicals;
  }

  get envelopeFactory(): EnvelopeFactory {
    return this._envelopeFactory;
  }

  get deliveryPolicy(): DeliveryPolicy | null {
    return this._deliveryPolicy;
  }

  get bindingManager(): BindingManager {
    return this._bindingManager;
  }

  get defaultBindingPath(): string {
    return this._defaultBindingPath;
  }

  get hasParent(): boolean {
    return this._hasParent;
  }

  get securityManager(): SecurityManager | null {
    return this._securityManager;
  }

  get admissionClient(): AdmissionClient | null {
    return this._admissionClient;
  }

  get eventListeners(): NodeEventListener[] {
    return this._eventListeners;
  }

  get upstreamConnector(): FameConnector | null {
    const manager = this._sessionManager;
    if (manager instanceof UpstreamSessionManager) {
      const activeConnector = manager.getActiveConnector();
      if (activeConnector) {
        return activeConnector;
      }
    }
    return this._upstreamConnector;
  }

  get publicUrl(): string | null {
    return this._publicUrl;
  }

  get storageProvider(): StorageProvider {
    return this._storageProvider;
  }

  get cryptoProvider(): CryptoProvider {
    return this._cryptoProvider;
  }

  get lastHeartbeatAt(): number | null {
    return this._lastHeartbeatAt;
  }

  get serviceManager(): ServiceManager {
    return this._serviceManager;
  }

  get handshakeCompleted(): boolean {
    return this._handshakeCompleted;
  }

  get welcomeExpiresAt(): string | null {
    return this._welcomeExpiresAt;
  }

  get attachExpiresAt(): Date | null {
    return this._attachExpiresAt;
  }

  addEventListener(listener: NodeEventListener): void {
    if (this._eventListeners.includes(listener)) {
      return;
    }
    this._eventListeners.push(listener);
    this._eventListeners.sort((a, b) => a.priority - b.priority);
  }

  removeEventListener(listener: NodeEventListener): void {
    const index = this._eventListeners.indexOf(listener);
    if (index >= 0) {
      this._eventListeners.splice(index, 1);
    }
  }

  async start(): Promise<void> {
    if (this._isStarted) {
      throw new Error('Node already started');
    }

    try {
      await this.dispatchEvent('onNodeInitialized', this);
      await this.initializeSessionManager();

      if (!this._sid && this._physicalPath) {
        this._sid = this.computeSid(this._physicalPath);
      }

      await this.persistNodeMeta();

      await this.listen(
        SYSTEM_INBOX,
        async (env: FameEnvelope, ctx?: FameDeliveryContext) => {
          await this.handleSystemFrame(env, ctx);
          return null;
        }
      );

      await this._serviceManager.start();

      await this.dispatchEvent('onNodeStarted', this);

      await this._bindingManager.restore();
      await this._envelopeListenerManager.start();

      this._isStarted = true;

      logger.debug('node_started', {
        node_id: this.id,
        sid: this.sid,
        path: this.physicalPath,
        logicals: this.acceptedLogicals,
      });
    } catch (error) {
      try {
        await this._serviceManager.stop();
      } catch {
        // Best-effort cleanup
      }
      await this.stopSessionManager();
      throw error;
    }
  }

  async prepareToStop(): Promise<void> {
    await this.dispatchEvent('onNodePreparingToStop', this);
  }

  async stop(): Promise<void> {
    if (!this._isStarted) {
      return;
    }
    await this.prepareToStop();
    await this.shutdownTasks({ gracePeriod: 100, joinTimeout: 100 });
    await this._envelopeListenerManager.stop();
    await this.stopSessionManager();
    await this._serviceManager.stop();
    await this.dispatchEvent('onNodeStopped', this);
    this._isStarted = false;
    logger.debug('node_stopped', {
      node_id: this.id,
    });
  }

  async bind(participant: string) {
    return this._bindingManager.bind(participant);
  }

  async unbind(participant: string): Promise<void> {
    await this._bindingManager.unbind(participant);
  }

  async listen(
    recipient: string,
    handler: FameEnvelopeHandler,
    pollTimeoutMs?: number
  ): Promise<FameAddress> {
    return this._envelopeListenerManager.listen(recipient, handler, {
      pollTimeoutMs: pollTimeoutMs ?? null,
    });
  }

  async listenRpc(
    serviceName: string,
    handler: FameRPCHandler,
    pollTimeoutMs: number
  ): Promise<FameAddress> {
    return this._envelopeListenerManager.listenRpc(serviceName, handler, {
      pollTimeoutMs: pollTimeoutMs ?? null,
    });
  }

  async invoke(
    targetAddr: FameAddress,
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): Promise<any> {
    return this._envelopeListenerManager.invoke({
      targetAddr,
      method,
      params,
      timeoutMs,
    });
  }

  async invokeByCapability(
    capabilities: string[],
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): Promise<any> {
    return this._envelopeListenerManager.invoke({
      capabilities,
      method,
      params,
      timeoutMs,
    });
  }

  async *invokeStream(
    targetAddr: FameAddress,
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): AsyncIterableIterator<any> {
    const stream = await this._envelopeListenerManager.invokeStream({
      targetAddr,
      method,
      params,
      timeoutMs,
    });

    for await (const item of stream) {
      yield item;
    }
  }

  async *invokeByCapabilityStream(
    capabilities: string[],
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): AsyncIterableIterator<any> {
    const stream = await this._envelopeListenerManager.invokeStream({
      capabilities,
      method,
      params,
      timeoutMs,
    });

    for await (const item of stream) {
      yield item;
    }
  }

  async send(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    _deliveryPolicy?: DeliveryPolicy | null,
    deliveryFn?: (env: FameEnvelope, ctx?: FameDeliveryContext) => Promise<any>,
    timeoutMs?: number
  ): Promise<DeliveryAckFrame | null> {
    let effectiveContext: FameDeliveryContext;

    if (!context) {
      effectiveContext = localDeliveryContext(this.id);
    } else {
      if (
        context.originType &&
        context.originType !== DeliveryOriginType.LOCAL
      ) {
        throw new Error('Can only send with LOCAL origin context');
      }
      if (context.fromConnector) {
        throw new Error('fromConnector must be null in LOCAL context');
      }

      effectiveContext = {
        ...context,
        originType: DeliveryOriginType.LOCAL,
        fromConnector: null,
      };
    }

    const deliveryPolicy = _deliveryPolicy ?? this._deliveryPolicy ?? null;
    const deliverFn =
      deliveryFn ??
      ((env: FameEnvelope, ctx?: FameDeliveryContext) =>
        this.deliver(env, ctx));

    const ackRequired = Boolean(deliveryPolicy?.isAckRequired(envelope));

    if (ackRequired) {
      envelope.rtype = envelope.rtype
        ? envelope.rtype | FameResponseType.ACK
        : FameResponseType.ACK;
    }

    const replyRequired = Boolean(
      envelope.rtype &&
        ((envelope.rtype & FameResponseType.REPLY) !== 0 ||
          (envelope.rtype & FameResponseType.STREAM) !== 0)
    );

    if (!envelope.traceId) {
      envelope.traceId = generateId();
    }

    if (!ackRequired && !replyRequired) {
      await deliverFn(envelope, effectiveContext);
      return null;
    }

    const retryPolicy: RetryPolicy | undefined =
      deliveryPolicy?.senderRetryPolicy;

    if (!envelope.corrId) {
      envelope.corrId = generateId();
    }

    if (!envelope.replyTo) {
      envelope.replyTo = formatAddress(SYSTEM_INBOX, this._physicalPath ?? '');
    }

    const retryHandler = retryPolicy
      ? new DefaultRetryHandler(deliverFn)
      : null;
    const effectiveTimeout = timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS;
    const expectedResponseType = envelope.rtype ?? FameResponseType.ACK;

    await this._deliveryTracker.track(envelope, {
      timeoutMs: effectiveTimeout,
      expectedResponseType,
      retryPolicy: retryPolicy ?? null,
      retryHandler,
    });

    await deliverFn(envelope, effectiveContext);

    if (!ackRequired) {
      return null;
    }

    const ackEnvelope = await this._deliveryTracker.awaitAck(
      envelope.id,
      effectiveTimeout
    );
    const ackFrame = ackEnvelope.frame;

    if (!ackFrame || ackFrame.type !== 'DeliveryAck') {
      throw new Error('Expected DeliveryAck frame in acknowledgement');
    }

    return ackFrame as DeliveryAckFrame;
  }

  async deliver(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const processedEnvelope = await this.runEnvelopeListeners('onDeliver', 1, [
      this,
      envelope,
      context,
    ]);

    if (!processedEnvelope) {
      return;
    }

    const frameType = processedEnvelope.frame?.type ?? null;

    if (
      frameType &&
      [
        'AddressBind',
        'AddressUnbind',
        'CapabilityAdvertise',
        'CapabilityWithdraw',
        'NodeHeartbeat',
      ].includes(frameType)
    ) {
      await this.forwardUpstream(processedEnvelope, context);
      return;
    }

    if (
      frameType &&
      [
        'AddressBindAck',
        'AddressUnbindAck',
        'CapabilityAdvertiseAck',
        'CapabilityWithdrawAck',
      ].includes(frameType)
    ) {
      await this._deliveryTracker.onEnvelopeDelivered(
        SYSTEM_INBOX,
        processedEnvelope,
        context
      );
      return;
    }

    // if (frameType === 'DeliveryAck') {
    //   if (!context || context.originType !== DeliveryOriginType.LOCAL) {
    //     await this._deliveryTracker.onEnvelopeDelivered(SYSTEM_INBOX, processedEnvelope, context);
    //     return;
    //   }
    // }

    if (
      frameType &&
      [
        'Data',
        'DeliveryAck',
        'SecureOpen',
        'SecureAccept',
        'SecureClose',
      ].includes(frameType)
    ) {
      if (processedEnvelope.to && this.hasLocal(processedEnvelope.to)) {
        await this.deliverLocal(
          processedEnvelope.to,
          processedEnvelope,
          context
        );
        return;
      }

      if (
        processedEnvelope.capabilities &&
        processedEnvelope.capabilities.length > 0
      ) {
        const resolved = await this._serviceManager.resolveAddressByCapability(
          processedEnvelope.capabilities
        );

        if (resolved) {
          await this.deliverLocal(resolved, processedEnvelope, context);
          return;
        }
      }
    }

    if (
      this._upstreamConnector &&
      context?.originType === DeliveryOriginType.LOCAL
    ) {
      if (
        !context.fromConnector ||
        context.fromConnector !== this._upstreamConnector
      ) {
        await this.forwardUpstream(processedEnvelope, context);
      } else {
        logger.error('attempted_upstream_loop', {
          envelopeId: processedEnvelope.id,
        });
      }
      return;
    }

    if (!processedEnvelope.to) {
      logger.error('dropping_envelope_without_destination', {
        envelopeId: processedEnvelope.id,
        capabilities: processedEnvelope.capabilities ?? [],
      });
      return;
    }

    logger.warning('no_local_handler_for_address', {
      address:
        processedEnvelope.to.toString?.() ?? String(processedEnvelope.to),
      originType: context?.originType ?? null,
    });
  }

  async deliverLocal(
    address: FameAddress,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const processedEnvelope = await this.runEnvelopeListeners(
      'onDeliverLocal',
      2,
      [this, address, envelope, context]
    );
    if (!processedEnvelope) {
      return;
    }

    const binding = this._bindingManager.getBinding(address);
    if (!binding) {
      throw new Error(`No local binding for address: ${address.toString()}`);
    }

    const channelMessage = createChannelMessage(processedEnvelope, context);
    await binding.channel.send(channelMessage);

    await this.runEnvelopeListeners('onDeliverLocalComplete', 2, [
      this,
      address,
      processedEnvelope,
      context,
    ]);
  }

  async forwardUpstream(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    if (context?.originType === DeliveryOriginType.UPSTREAM) {
      return;
    }

    let processedEnvelope: FameEnvelope | null = null;

    try {
      processedEnvelope = await this.runEnvelopeListeners(
        'onForwardUpstream',
        1,
        [this, envelope, context]
      );

      if (!processedEnvelope) {
        return;
      }

      if (!this._upstreamConnector) {
        await this.runEnvelopeListeners('onForwardUpstreamComplete', 1, [
          this,
          processedEnvelope,
          undefined,
          undefined,
          context,
        ]);
        return;
      }

      const manager = this._sessionManager;
      if (!manager || !(manager instanceof UpstreamSessionManager)) {
        await this.runEnvelopeListeners('onForwardUpstreamComplete', 1, [
          this,
          processedEnvelope,
          undefined,
          undefined,
          context,
        ]);
        return;
      }

      await manager.send(processedEnvelope);

      await this.runEnvelopeListeners('onForwardUpstreamComplete', 1, [
        this,
        processedEnvelope,
        undefined,
        undefined,
        context,
      ]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.runEnvelopeListeners('onForwardUpstreamComplete', 1, [
        this,
        processedEnvelope ?? envelope,
        undefined,
        err,
        context,
      ]);
      throw err;
    }
  }

  hasLocal(address: FameAddress | string): boolean {
    if (this._bindingManager.hasBinding(address)) {
      return true;
    }

    try {
      const [, location] = parseAddress(address.toString());
      return location === this._physicalPath;
    } catch {
      return false;
    }
  }

  gatherSupportedCallbackGrants(): Record<string, any>[] {
    const grants: Record<string, any>[] = [];
    const seen = new Set<string>();

    const addGrant = (grant: Record<string, any>) => {
      let signature: string | null = null;
      try {
        signature = JSON.stringify(grant);
      } catch {
        // Non-serializable grant; allow duplicates to ensure availability
      }

      if (signature !== null) {
        if (seen.has(signature)) {
          return;
        }
        seen.add(signature);
      }

      grants.push(grant);
    };

    const processCandidate = (candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') {
        return;
      }

      try {
        const asAny = candidate as {
          asCallbackGrant?: () => Record<string, any> | null;
          getCallbackGrant?: () => Record<string, any> | null;
        };

        let grant: Record<string, any> | null | undefined;

        if (typeof asAny.asCallbackGrant === 'function') {
          grant = asAny.asCallbackGrant();
        } else if (typeof asAny.getCallbackGrant === 'function') {
          grant = asAny.getCallbackGrant();
        }

        if (grant) {
          addGrant(grant);
        }
      } catch (error) {
        logger.warning('callback_grant_collection_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    for (const listener of this._transportListeners) {
      processCandidate(listener);
    }

    for (const listener of this._eventListeners) {
      if (this._transportListeners.includes(listener as TransportListener)) {
        continue;
      }
      processCandidate(listener);
    }

    return grants;
  }

  async dispatchEvent(eventName: string, ...args: any[]): Promise<void> {
    for (const listener of this._eventListeners) {
      const handler = resolveListenerMethod(listener, eventName);
      if (handler) {
        await handler(...args);
      }
    }
  }

  async dispatchEnvelopeEvent(
    eventName: string,
    ...args: any[]
  ): Promise<FameEnvelope | null> {
    const argsWithNode =
      args.length > 0 && args[0] === this ? args : [this, ...args];

    const envelopeIndex = argsWithNode.findIndex(
      (value) => value && typeof value === 'object' && 'frame' in value
    );

    if (envelopeIndex === -1) {
      throw new Error(
        `dispatchEnvelopeEvent(${eventName}) requires an envelope argument`
      );
    }

    return this.runEnvelopeListeners(eventName, envelopeIndex, argsWithNode);
  }

  private computeSid(physicalPath: string): string {
    return secureDigest(physicalPath);
  }

  private async runEnvelopeListeners(
    eventName: string,
    envelopeIndex: number,
    args: any[]
  ): Promise<FameEnvelope | null> {
    let currentEnvelope: FameEnvelope | null = args[envelopeIndex] ?? null;

    for (const listener of this._eventListeners) {
      const handler = resolveListenerMethod(listener, eventName);
      if (!handler) {
        continue;
      }

      const result = await handler(...args);

      if (result === null) {
        return null;
      }

      if (result !== undefined) {
        currentEnvelope = result;
        args[envelopeIndex] = currentEnvelope;
      }
    }

    return currentEnvelope;
  }

  private async persistNodeMeta(): Promise<void> {
    try {
      const store = await this._nodeMetaStorePromise;
      const existing = await store.get('self');
      const record = existing
        ? Object.assign(existing, { id: this.id })
        : new NodeMetaRecord(this.id);
      await store.set('self', record);
    } catch (error) {
      logger.warning('node_meta_persist_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
