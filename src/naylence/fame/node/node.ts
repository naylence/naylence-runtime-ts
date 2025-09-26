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
} from 'naylence-core';
import type { DeliveryAckFrame, FameConnector, FameEnvelopeHandler, FameRPCHandler } from 'naylence-core';
import { generateId } from 'naylence-core';
import { secureDigest } from '../util/util.js';
import type { DeliveryPolicy } from '../delivery/delivery-policy.js';
import type { SecurityManager } from '../security/security-manager.js';
import type { AdmissionClient } from './admission/admission-client.js';
import type { NodeEventListener } from './node-event-listener.js';
import type { StorageProvider, KeyValueStore } from '../storage/index.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage.js';
import { NodeEnvelopeFactory } from './node-envelope-factory.js';
import type { EnvelopeFactory } from 'naylence-core';
import { BindingManager } from './binding-manager.js';
import type { BindingStoreEntry, BindingManagerOptions } from './binding-manager.js';
import { EnvelopeListenerManager } from './envelope-listener-manager.js';
import { DefaultDeliveryTracker } from '../delivery/default-delivery-tracker.js';
import type { RetryPolicy } from '../delivery/retry-policy.js';
import type { RetryEventHandler } from '../delivery/retry-event-handler.js';
import type { NodeLike } from './node-like.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { pushNode } from './node-context-stack.js';
import { getLogger } from '../util/logging.js';
import type { NodeAttachClient, AttachInfo } from './admission/node-attach-client.js';
import type { NodeWelcomeFrame } from 'naylence-core';
import { RootSessionManager } from './root-session-manager.js';
import { UpstreamSessionManager } from './upstream-session-manager.js';
import type { SessionManager } from './session-manager.js';
import { NoopAdmissionClient } from './admission/noop-admission-client.js';
import { NodeMetaRecord, NODE_META_NAMESPACE } from './node-meta.js';
import type { TransportListener } from '../connector/transport-listener.js';
import type { ServiceManager } from '../service/service-manager.js';
import { DefaultServiceManager } from '../service/default-service-manager.js';

const SYSTEM_INBOX = '__sys__';

const logger = getLogger('fame-node');

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
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
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

function resolveListenerMethod(listener: NodeEventListener, eventName: string): ((...args: any[]) => any) | undefined {
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
  serviceCapabilityMap?: Map<string, FameAddress> | Record<string, FameAddress> | null;
  servicePollTimeoutMs?: number | null;
  defaultServiceConfigs?: Array<Record<string, unknown>>;
  nodeMetaStore?: KeyValueStore<NodeMetaRecord> | null;
  transportListeners?: TransportListener[];
}

function sortListeners(listeners: NodeEventListener[]): NodeEventListener[] {
  return [...listeners].sort((a, b) => a.priority - b.priority);
}

export class FameNode extends TaskSpawner implements NodeLike {
  private _id: string;
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
  private readonly _nodeMetaStorePromise: Promise<KeyValueStore<NodeMetaRecord>>;
  private readonly _transportListeners: TransportListener[];
  private _defaultBindingPath: string;
  private _sessionManager: SessionManager | null = null;
  private _upstreamConnector: FameConnector | null = null;
  private _isStarted = false;
  private _releaseNodeContext: (() => void) | null = null;
  private _lastHeartbeatAt: number | null = null;
  private _handshakeCompleted: boolean;
  private _welcomeExpiresAt: string | null;
  private _attachExpiresAt: Date | null;

  constructor(options: FameNodeOptions = {}) {
    super();
    this._id = options.systemId ?? generateId();
    this._physicalPath = options.physicalPath ?? `/${this._id}`;
    this._hasParent = options.hasParent ?? false;
    this._storageProvider = options.storageProvider ?? new InMemoryStorageProvider();
    this._acceptedLogicals = new Set(options.acceptedLogicals ?? []);
    this._deliveryPolicy = options.deliveryPolicy ?? null;
    this._admissionClient = options.admissionClient ?? null;
    this._attachClient = options.attachClient ?? null;
    this._requestedLogicals = [...(options.requestedLogicals ?? [])];
    this._securityManager = options.securityManager ?? null;
    this._publicUrl = options.publicUrl ?? null;

    const envelopeFactory = options.envelopeFactory ?? new NodeEnvelopeFactory(() => this.sid ?? '');
    this._envelopeFactory = envelopeFactory;

    const tracker = options.deliveryTracker ?? new DefaultDeliveryTracker(this._storageProvider);
    this._deliveryTracker = tracker;

    this._nodeMetaStorePromise = options.nodeMetaStore
      ? Promise.resolve(options.nodeMetaStore)
      : this._storageProvider.getKeyValueStore(NodeMetaRecord, NODE_META_NAMESPACE);

    const transportListeners = options.transportListeners ? [...options.transportListeners] : [];
    this._transportListeners = transportListeners;

    const listeners: NodeEventListener[] = options.eventListeners ? [...options.eventListeners] : [];

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

    const bindingManagerOptions: BindingManagerOptions = {
      hasUpstream: this._hasParent,
      getId: () => this._id,
      getPhysicalPath: () => this._physicalPath,
      getAcceptedLogicals: () => this._acceptedLogicals,
      forwardUpstream: (envelope, context) => this.forwardUpstream(envelope, context),
      envelopeFactory: this._envelopeFactory,
      deliveryTracker: this._deliveryTracker,
      getEncryptionKeyId: () => this._securityManager?.getEncryptionKeyId() ?? null,
    };

    if (options.bindingStore) {
      bindingManagerOptions.bindingStore = options.bindingStore;
    }

    this._bindingManager = new BindingManager(bindingManagerOptions);

    this._envelopeListenerManager = new EnvelopeListenerManager({
      bindingManager: this._bindingManager,
      nodeLike: this,
      envelopeFactory: this._envelopeFactory,
      deliveryTracker: this._deliveryTracker,
    });

    const serviceManager = options.serviceManager
      ? options.serviceManager
      : new DefaultServiceManager({
          invoke: (targetAddr, method, params, timeoutMs) =>
            this.invoke(targetAddr, method, params, timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MILLIS),
          serve: (serviceName, handler, serveOptions) =>
            this._envelopeListenerManager.listen(serviceName, handler, serveOptions ?? {}),
          serveRpc: (serviceName, handler, serveOptions) =>
            this._envelopeListenerManager.listenRpc(serviceName, handler, serveOptions ?? {}),
          capabilityMap: options.serviceCapabilityMap ?? undefined,
          pollTimeoutMs: options.servicePollTimeoutMs ?? null,
          defaultServiceConfigs: options.defaultServiceConfigs ?? [],
        });

    this._serviceManager = serviceManager;

    this._defaultBindingPath = this._physicalPath;
    this._sid = this._hasParent && options.physicalPath === undefined ? null : this.computeSid(this._physicalPath);
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
    const admissionClient = this._admissionClient ?? new NoopAdmissionClient({ systemId: this._id });

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
      inboundHandler: (envelope, context) => this.handleInboundFromUpstream(envelope, context),
      onWelcome: (frame) => this.handleWelcome(frame),
      onAttach: (info, connector) => this.handleAttach(info, connector),
      onEpochChange: (epoch) => this.handleEpochChange(epoch),
      admissionClient: this._admissionClient,
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

  private async handleWelcome(welcome: NodeWelcomeFrame): Promise<void> {
    if (welcome.systemId) {
      this._id = welcome.systemId;
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

  private async handleAttach(info: AttachInfo, connector: FameConnector): Promise<void> {
    this._id = info.systemId;
    this._physicalPath = info.assignedPath ?? info.targetPhysicalPath ?? this._physicalPath;
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

    await this._deliveryTracker.onEnvelopeDelivered(SYSTEM_INBOX, envelope, context);

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
    return this._id;
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
    return this._upstreamConnector;
  }

  get publicUrl(): string | null {
    return this._publicUrl;
  }

  get storageProvider(): StorageProvider {
    return this._storageProvider;
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

      const release = pushNode(this);
      try {
        await this.dispatchEvent('onNodeInitialized', this);
        await this.initializeSessionManager();

        if (!this._sid && this._physicalPath) {
          this._sid = this.computeSid(this._physicalPath);
        }

        await this.persistNodeMeta();

        await this.listen(SYSTEM_INBOX, async (env, ctx) => {
          await this.handleSystemFrame(env, ctx);
          return null;
        });

      await this._serviceManager.start();

      await this.dispatchEvent('onNodeStarted', this);

      await this._bindingManager.restore();
      await this._envelopeListenerManager.start();

        this._releaseNodeContext = release;
        this._isStarted = true;
      } catch (error) {
        release();
      try {
        await this._serviceManager.stop();
      } catch {
        // Best-effort cleanup
      }
        await this.stopSessionManager();
        throw error;
      }
  }

  async stop(): Promise<void> {
    if (!this._isStarted) {
      return;
    }

    await this.dispatchEvent('onNodePreparingToStop', this);
    await this.shutdownTasks({ gracePeriod: 100, joinTimeout: 100 });
    await this._envelopeListenerManager.stop();
    await this.stopSessionManager();
    await this._serviceManager.stop();
    await this.dispatchEvent('onNodeStopped', this);
    this._isStarted = false;
    if (this._releaseNodeContext) {
      this._releaseNodeContext();
      this._releaseNodeContext = null;
    }
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
      if (context.originType && context.originType !== DeliveryOriginType.LOCAL) {
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
      deliveryFn ?? ((env: FameEnvelope, ctx?: FameDeliveryContext) => this.deliver(env, ctx));

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

    const retryPolicy: RetryPolicy | undefined = deliveryPolicy?.senderRetryPolicy;

    if (!envelope.corrId) {
      envelope.corrId = generateId();
    }

    if (!envelope.replyTo) {
      envelope.replyTo = formatAddress(SYSTEM_INBOX, this._physicalPath ?? '');
    }

    const retryHandler = retryPolicy ? new DefaultRetryHandler(deliverFn) : null;
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

    const ackEnvelope = await this._deliveryTracker.awaitAck(envelope.id, effectiveTimeout);
    const ackFrame = ackEnvelope.frame;

    if (!ackFrame || ackFrame.type !== 'DeliveryAck') {
      throw new Error('Expected DeliveryAck frame in acknowledgement');
    }

    return ackFrame as DeliveryAckFrame;
  }

  async deliver(envelope: FameEnvelope, context?: FameDeliveryContext): Promise<void> {
    const processedEnvelope = await this.runEnvelopeListeners(
      'onDeliver',
      1,
      [this, envelope, context]
    );

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
      await this._deliveryTracker.onEnvelopeDelivered(SYSTEM_INBOX, processedEnvelope, context);
      return;
    }

    if (frameType === 'DeliveryAck') {
      await this._deliveryTracker.onEnvelopeDelivered(SYSTEM_INBOX, processedEnvelope, context);
      return;
    }

    if (frameType && ['Data', 'SecureOpen', 'SecureAccept', 'SecureClose'].includes(frameType)) {
      if (processedEnvelope.to && this.hasLocal(processedEnvelope.to)) {
        await this.deliverLocal(processedEnvelope.to, processedEnvelope, context);
        return;
      }

      if (processedEnvelope.capabilities && processedEnvelope.capabilities.length > 0) {
        const resolved = await this._serviceManager.resolveAddressByCapability(
          processedEnvelope.capabilities
        );

        if (resolved) {
          await this.deliverLocal(resolved, processedEnvelope, context);
          return;
        }
      }
    }

    if (this._upstreamConnector && context?.originType === DeliveryOriginType.LOCAL) {
      if (!context.fromConnector || context.fromConnector !== this._upstreamConnector) {
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
      address: processedEnvelope.to.toString?.() ?? String(processedEnvelope.to),
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

    await this.runEnvelopeListeners('onDeliverLocalComplete', 2, [this, address, processedEnvelope, context]);
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
        await this.runEnvelopeListeners(
          'onForwardUpstreamComplete',
          1,
          [this, processedEnvelope, undefined, undefined, context]
        );
        return;
      }

      const manager = this._sessionManager;
      if (!manager || !(manager instanceof UpstreamSessionManager)) {
        await this.runEnvelopeListeners(
          'onForwardUpstreamComplete',
          1,
          [this, processedEnvelope, undefined, undefined, context]
        );
        return;
      }

      await manager.send(processedEnvelope);

      await this.runEnvelopeListeners(
        'onForwardUpstreamComplete',
        1,
        [this, processedEnvelope, undefined, undefined, context]
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.runEnvelopeListeners(
        'onForwardUpstreamComplete',
        1,
        [this, processedEnvelope ?? envelope, undefined, err, context]
      );
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

  async dispatchEnvelopeEvent(eventName: string, ...args: any[]): Promise<FameEnvelope | null> {
    const argsWithNode = args.length > 0 && args[0] === this ? args : [this, ...args];

    const envelopeIndex = argsWithNode.findIndex(
      (value) => value && typeof value === 'object' && 'frame' in value
    );

    if (envelopeIndex === -1) {
      throw new Error(`dispatchEnvelopeEvent(${eventName}) requires an envelope argument`);
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
      const record = existing ? Object.assign(existing, { id: this._id }) : new NodeMetaRecord(this._id);
      await store.set('self', record);
    } catch (error) {
      logger.warning('node_meta_persist_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}