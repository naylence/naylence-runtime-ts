import {
  DEFAULT_INVOKE_TIMEOUT_MILLIS,
  DeliveryOriginType,
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
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
import type { StorageProvider } from '../storage/index.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage.js';
import { NodeEnvelopeFactory } from './node-envelope-factory.js';
import type { EnvelopeFactory } from 'naylence-core';
import { BindingManager } from './binding-manager.js';
import { EnvelopeListenerManager } from './envelope-listener-manager.js';
import { DefaultDeliveryTracker } from '../delivery/default-delivery-tracker.js';
import type { RetryPolicy } from '../delivery/retry-policy.js';
import type { RetryEventHandler } from '../delivery/retry-event-handler.js';
import type { NodeLike } from './node-like.js';

const SYSTEM_INBOX = '__sys__';

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
  securityManager?: SecurityManager | null;
  publicUrl?: string | null;
}

function sortListeners(listeners: NodeEventListener[]): NodeEventListener[] {
  return [...listeners].sort((a, b) => a.priority - b.priority);
}

export class FameNode implements NodeLike {
  private _id: string;
  private _sid: string | null;
  private _physicalPath: string;
  private _acceptedLogicals: Set<string>;
  private readonly _hasParent: boolean;
  private readonly _storageProvider: StorageProvider;
  private readonly _bindingManager: BindingManager;
  private readonly _envelopeListenerManager: EnvelopeListenerManager;
  private readonly _deliveryTracker: DefaultDeliveryTracker;
  private readonly _eventListeners: NodeEventListener[];
  private readonly _envelopeFactory: EnvelopeFactory;
  private readonly _deliveryPolicy: DeliveryPolicy | null;
  private readonly _admissionClient: AdmissionClient | null;
  private readonly _securityManager: SecurityManager | null;
  private readonly _publicUrl: string | null;
  private readonly _defaultBindingPath: string;
  private _isStarted = false;

  constructor(options: FameNodeOptions = {}) {
    this._id = options.systemId ?? generateId();
    this._physicalPath = options.physicalPath ?? `/${this._id}`;
    this._hasParent = options.hasParent ?? false;
    this._storageProvider = options.storageProvider ?? new InMemoryStorageProvider();
    this._acceptedLogicals = new Set(options.acceptedLogicals ?? []);
    this._deliveryPolicy = options.deliveryPolicy ?? null;
    this._admissionClient = options.admissionClient ?? null;
    this._securityManager = options.securityManager ?? null;
    this._publicUrl = options.publicUrl ?? null;

    const envelopeFactory = options.envelopeFactory ?? new NodeEnvelopeFactory(() => this.sid ?? '');
    this._envelopeFactory = envelopeFactory;

    const tracker = new DefaultDeliveryTracker(this._storageProvider);
    this._deliveryTracker = tracker;

    const listeners = options.eventListeners ? [...options.eventListeners, tracker] : [tracker];
    this._eventListeners = sortListeners(listeners);

    this._bindingManager = new BindingManager({
      hasUpstream: this._hasParent,
      getId: () => this._id,
      getPhysicalPath: () => this._physicalPath,
      getAcceptedLogicals: () => this._acceptedLogicals,
      forwardUpstream: (envelope, context) => this.forwardUpstream(envelope, context),
      envelopeFactory: this._envelopeFactory,
      deliveryTracker: this._deliveryTracker,
      getEncryptionKeyId: () => this._securityManager?.getEncryptionKeyId() ?? null,
    });

    this._envelopeListenerManager = new EnvelopeListenerManager({
      bindingManager: this._bindingManager,
      nodeLike: this,
      envelopeFactory: this._envelopeFactory,
      deliveryTracker: this._deliveryTracker,
    });

    this._defaultBindingPath = this._physicalPath;
    this._sid = this.computeSid(this._physicalPath);
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
    return null;
  }

  get publicUrl(): string | null {
    return this._publicUrl;
  }

  get storageProvider(): StorageProvider {
    return this._storageProvider;
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

    await this.dispatchEvent('onNodeInitialized', this);
    await this._bindingManager.restore();
    await this._envelopeListenerManager.start();
    await this.dispatchEvent('onNodeStarted', this);

    this._isStarted = true;
  }

  async stop(): Promise<void> {
    if (!this._isStarted) {
      return;
    }

    await this.dispatchEvent('onNodePreparingToStop', this);
    await this._envelopeListenerManager.stop();
    await this.dispatchEvent('onNodeStopped', this);
    this._isStarted = false;
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
        throw new Error('Capability-based routing is not implemented yet');
      }
    }

    if (context?.originType === DeliveryOriginType.LOCAL) {
      await this.forwardUpstream(processedEnvelope, context);
      return;
    }

    if (!processedEnvelope.to) {
      throw new Error('Capability-based routing is not implemented yet');
    }

    throw new Error(`No local handler for address ${processedEnvelope.to}`);
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

    await this._envelopeListenerManager.deliverToAddress(address, processedEnvelope, context);

    // Completion events can be added once needed
  }

  async forwardUpstream(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const processedEnvelope = await this.runEnvelopeListeners(
      'onForwardUpstream',
      1,
      [this, envelope, context]
    );
    if (!processedEnvelope) {
      return;
    }

    await this.runEnvelopeListeners(
      'onForwardUpstreamComplete',
      1,
      [this, processedEnvelope, undefined, undefined, context]
    );
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
    return [];
  }

  async dispatchEvent(eventName: string, ...args: any[]): Promise<void> {
    for (const listener of this._eventListeners) {
      const handler = (listener as any)[eventName];
      if (typeof handler === 'function') {
        await handler.apply(listener, args);
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
      const handler = (listener as any)[eventName];
      if (typeof handler !== 'function') {
        continue;
      }

      const result = await handler.apply(listener, args);

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
}