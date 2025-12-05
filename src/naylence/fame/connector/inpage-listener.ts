import {
  DeliveryOriginType,
  FameChannelMessage,
  FameResponseType,
  deserializeEnvelope,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type NodeAttachFrame,
} from '@naylence/core';

import { TransportListener } from './transport-listener.js';
import type { NodeLike } from '../node/node-like.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import { getLogger } from '../util/logging.js';
import { GRANT_PURPOSE_NODE_ATTACH } from '../grants/grant.js';
import { INPAGE_CONNECTOR_TYPE } from './inpage-connector.js';
import type { ConnectorConfig } from './connector-config.js';
import {
  GrantSelectionContext,
  defaultGrantSelectionPolicy,
} from './grant-selection-policy.js';
import type { ConnectionGrant } from '../grants/connection-grant.js';
import {
  INPAGE_CONNECTION_GRANT_TYPE,
  inPageGrantToConnectorConfig,
  type InPageConnectionGrantLike,
} from '../grants/inpage-connection-grant.js';
import { QueueFullError } from '../util/bounded-async-queue.js';

const logger = getLogger('naylence.fame.connector.inpage_listener');

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

const isBrowserEnvironment = (): boolean =>
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  typeof EventTarget !== 'undefined' &&
  typeof MessageEvent !== 'undefined';

const ensureBrowserEnvironment = (): void => {
  if (!isBrowserEnvironment()) {
    throw new Error(
      'InPageListener is browser-only and requires DOM EventTarget support'
    );
  }
};

export interface InPageListenerOptions {
  channelName?: string;
  inboxCapacity?: number;
}

let _lastInPageListenerInstance: InPageListener | null = null;

interface ConnectorEntry {
  connector: FameConnector;
  systemId: string;
  originType: DeliveryOriginType;
}

const getSharedBus = (): EventTarget => {
  ensureBrowserEnvironment();

  const globalWithBus = globalThis as typeof globalThis & {
    __naylence_inpage_bus__?: EventTarget;
  };

  if (!globalWithBus.__naylence_inpage_bus__) {
    globalWithBus.__naylence_inpage_bus__ = new EventTarget();
  }

  return globalWithBus.__naylence_inpage_bus__ as EventTarget;
};

const coercePayload = (raw: unknown): Uint8Array | null => {
  if (raw instanceof Uint8Array) {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (raw && typeof raw === 'object') {
    const candidate = raw as { constructor?: { name?: string } };
    if (candidate.constructor?.name === 'Uint8Array') {
      const view = raw as ArrayBufferView & { buffer: ArrayBuffer };
      return new Uint8Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
      );
    }
  }

  if (Array.isArray(raw) && raw.every((item) => typeof item === 'number')) {
    return Uint8Array.from(raw as number[]);
  }

  return null;
};

const isRoutingNodeLike = (node: NodeLike): node is RoutingNodeLike =>
  typeof (node as RoutingNodeLike).createOriginConnector === 'function';

export class InPageListener extends TransportListener {
  private readonly _channelName: string;
  private readonly _inboxCapacity: number;
  private _isRunning = false;
  private _initialized = false;
  private _routingNode: RoutingNodeLike | null = null;
  private _bus: EventTarget | null = null;
  private _busHandler: ((event: Event) => void) | null = null;
  private readonly _senderRegistry = new Map<string, ConnectorEntry>();
  private readonly _systemToSender = new Map<string, string>();
  private readonly _pendingAttachments = new Map<
    string,
    Promise<ConnectorEntry | null>
  >();

  constructor(options?: InPageListenerOptions) {
    super();
    ensureBrowserEnvironment();

    const channelCandidate = options?.channelName;
    const inboxCandidate = options?.inboxCapacity;

    this._channelName =
      typeof channelCandidate === 'string' && channelCandidate.trim().length > 0
        ? channelCandidate.trim()
        : DEFAULT_CHANNEL;

    const normalizedCapacity =
      typeof inboxCandidate === 'number' &&
      Number.isFinite(inboxCandidate) &&
      inboxCandidate > 0
        ? Math.floor(inboxCandidate)
        : DEFAULT_INBOX_CAPACITY;

    this._inboxCapacity = normalizedCapacity;

    _lastInPageListenerInstance = this;
  }

  get channelName(): string {
    return this._channelName;
  }

  get inboxCapacity(): number {
    return this._inboxCapacity;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  async onNodeInitialized(node: NodeLike): Promise<void> {
    ensureBrowserEnvironment();
    if (this._initialized) {
      return;
    }

    this._routingNode = isRoutingNodeLike(node) ? node : null;
    this._initialized = true;

    logger.debug('inpage_listener_initialized', {
      channel: this._channelName,
      inbox_capacity: this._inboxCapacity,
      routing_capable: Boolean(this._routingNode),
    });
  }

  async onNodeStarted(node: NodeLike): Promise<void> {
    ensureBrowserEnvironment();
    if (this._isRunning) {
      return;
    }

    if (!this._routingNode && isRoutingNodeLike(node)) {
      this._routingNode = node;
    }

    if (this._routingNode) {
      this._registerBusListener();
    } else {
      logger.warning('inpage_listener_missing_routing_capability');
    }

    this._isRunning = true;

    logger.debug('inpage_listener_started', {
      channel: this._channelName,
    });
  }

  async onNodeStopped(_node: NodeLike): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    this._isRunning = false;
    this._unregisterBusListener();
    this._senderRegistry.clear();
    this._systemToSender.clear();
    this._pendingAttachments.clear();

    logger.debug('inpage_listener_stopped', {
      channel: this._channelName,
    });
  }

  override getCallbackGrant(): Record<string, unknown> | null {
    return this.withLegacySnakeCaseKeys({
      type: INPAGE_CONNECTION_GRANT_TYPE,
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      channelName: this._channelName,
      inboxCapacity: this._inboxCapacity,
    });
  }

  override asCallbackGrant(): Record<string, unknown> | null {
    return this.withLegacySnakeCaseKeys({
      type: INPAGE_CONNECTOR_TYPE,
      channelName: this._channelName,
      inboxCapacity: this._inboxCapacity,
    });
  }

  private _registerBusListener(): void {
    if (this._busHandler) {
      return;
    }

    const handler = (event: Event): void => {
      void this._handleBusEvent(event);
    };

    const bus = getSharedBus();
    bus.addEventListener(this._channelName, handler as EventListener);

    this._bus = bus;
    this._busHandler = handler;
  }

  private _unregisterBusListener(): void {
    if (!this._bus || !this._busHandler) {
      return;
    }

    this._bus.removeEventListener(
      this._channelName,
      this._busHandler as EventListener
    );
    this._bus = null;
    this._busHandler = null;
  }

  private async _handleBusEvent(event: Event): Promise<void> {
    if (!this._routingNode) {
      return;
    }

    const normalized = this._parseBusEvent(event);
    if (!normalized) {
      return;
    }

    const { senderId, envelope } = normalized;

    if (this._isNodeAttachFrame(envelope.frame)) {
      await this._handleAttachFrame(senderId, envelope);
      return;
    }

    const entry = this._senderRegistry.get(senderId);
    if (!entry) {
      logger.debug('inpage_listener_no_connector_for_sender', {
        sender_id: senderId,
        frame_type: envelope.frame?.type ?? 'unknown',
      });
      return;
    }

    await this._deliverEnvelope(entry, envelope);
  }

  private _parseBusEvent(
    event: Event
  ): { senderId: string; envelope: FameEnvelope } | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const messageEvent = event as MessageEvent<unknown>;
    const payloadContainer = messageEvent?.data;
    if (!payloadContainer || typeof payloadContainer !== 'object') {
      return null;
    }

    const record = payloadContainer as {
      senderId?: unknown;
      payload?: unknown;
    };
    const senderId = record.senderId;
    if (typeof senderId !== 'string' || senderId.length === 0) {
      return null;
    }

    const payload = coercePayload(record.payload);
    if (!payload) {
      logger.debug('inpage_listener_ignored_event_without_payload', {
        sender_id: senderId,
      });
      return null;
    }

    let envelope: FameEnvelope;
    try {
      const decoded = new TextDecoder().decode(payload);
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      envelope = deserializeEnvelope(parsed);
    } catch (error) {
      logger.debug('inpage_listener_envelope_parse_failed', {
        sender_id: senderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    return { senderId, envelope };
  }

  private async _handleAttachFrame(
    senderId: string,
    envelope: FameEnvelope
  ): Promise<void> {
    const frame = envelope.frame as NodeAttachFrame;
    const systemId = frame.systemId;
    if (typeof systemId !== 'string' || systemId.length === 0) {
      logger.warning('inpage_listener_attach_missing_system_id', {
        sender_id: senderId,
      });
      return;
    }

    const normalizedOrigin = frame.originType ?? DeliveryOriginType.DOWNSTREAM;

    const existingEntry = this._senderRegistry.get(senderId);
    if (existingEntry) {
      await this._deliverEnvelope(existingEntry, envelope);
      return;
    }

    const pending = this._pendingAttachments.get(senderId);
    if (pending) {
      await pending.catch(() => null);
      return;
    }

    const creationPromise = this._createConnectorForAttach({
      senderId,
      frame,
      envelope,
      originType: normalizedOrigin,
    });

    this._pendingAttachments.set(senderId, creationPromise);
    const entry = await creationPromise.catch(() => null);
    this._pendingAttachments.delete(senderId);

    if (!entry) {
      return;
    }

    this._senderRegistry.set(senderId, entry);
    this._systemToSender.set(entry.systemId, senderId);

    await this._deliverEnvelope(entry, envelope);
  }

  private async _createConnectorForAttach(params: {
    senderId: string;
    frame: NodeAttachFrame;
    envelope: FameEnvelope;
    originType: DeliveryOriginType;
  }): Promise<ConnectorEntry | null> {
    const routingNode = this._routingNode;
    if (!routingNode) {
      return null;
    }

    const { frame, originType } = params;
    const systemId = frame.systemId;

    let connectorConfig: ConnectorConfig | null = null;

    try {
      const selectionContext = new GrantSelectionContext({
        childId: systemId,
        attachFrame: frame,
        callbackGrantType: INPAGE_CONNECTION_GRANT_TYPE,
        node: routingNode,
      });

      const selection =
        defaultGrantSelectionPolicy.selectCallbackGrant(selectionContext);
      connectorConfig = this._buildConnectorConfigForSystem(
        systemId,
        this._grantToConnectorConfig(selection.grant)
      );
    } catch (error) {
      logger.debug('inpage_listener_grant_selection_failed', {
        sender_id: params.senderId,
        system_id: systemId,
        error: error instanceof Error ? error.message : String(error),
      });

      const fallbackConfig =
        this._extractInPageConnectorConfig(frame) ??
        ({
          type: INPAGE_CONNECTOR_TYPE,
          channelName: this._channelName,
          inboxCapacity: this._inboxCapacity,
        } satisfies ConnectorConfig);
      connectorConfig = this._buildConnectorConfigForSystem(
        systemId,
        fallbackConfig
      );
    }

    try {
      const connector = await routingNode.createOriginConnector({
        originType,
        systemId,
        connectorConfig,
      });

      this._monitorConnectorLifecycle(params.senderId, systemId, connector);

      logger.debug('inpage_listener_created_connector', {
        sender_id: params.senderId,
        system_id: systemId,
        origin_type: originType,
        connector_type: connector.constructor?.name ?? 'unknown',
      });

      return { connector, systemId, originType };
    } catch (error) {
      logger.error('inpage_listener_connector_creation_failed', {
        sender_id: params.senderId,
        system_id: systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private _extractInPageConnectorConfig(
    frame: NodeAttachFrame
  ): ConnectorConfig | null {
    const rawGrants = frame.callbackGrants as
      | InPageConnectionGrantLike[]
      | undefined;
    if (!Array.isArray(rawGrants)) {
      return null;
    }

    for (const grant of rawGrants) {
      if (
        grant &&
        typeof grant === 'object' &&
        (grant.type === INPAGE_CONNECTION_GRANT_TYPE ||
          grant.type === INPAGE_CONNECTOR_TYPE)
      ) {
        try {
          return inPageGrantToConnectorConfig(grant);
        } catch (error) {
          logger.debug('inpage_listener_grant_normalization_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return null;
  }

  private _grantToConnectorConfig(grant: ConnectionGrant): ConnectorConfig {
    if (grant.type === INPAGE_CONNECTION_GRANT_TYPE) {
      return inPageGrantToConnectorConfig(grant as InPageConnectionGrantLike);
    }

    if (
      typeof (grant as { toConnectorConfig?: () => ConnectorConfig })
        ?.toConnectorConfig === 'function'
    ) {
      return (
        grant as { toConnectorConfig: () => ConnectorConfig }
      ).toConnectorConfig();
    }

    throw new Error(`Unsupported grant type: ${grant.type}`);
  }

  private _monitorConnectorLifecycle(
    senderId: string,
    systemId: string,
    connector: FameConnector
  ): void {
    const maybeClosable = connector as {
      waitUntilClosed?: () => Promise<void>;
    };

    if (typeof maybeClosable.waitUntilClosed !== 'function') {
      return;
    }

    void maybeClosable
      .waitUntilClosed()
      .then(() => {
        this._senderRegistry.delete(senderId);
        if (this._systemToSender.get(systemId) === senderId) {
          this._systemToSender.delete(systemId);
        }
      })
      .catch((error: unknown) => {
        logger.debug('inpage_listener_wait_until_closed_failed', {
          sender_id: senderId,
          system_id: systemId,
          error: error instanceof Error ? error.message : String(error),
        });
        this._senderRegistry.delete(senderId);
        if (this._systemToSender.get(systemId) === senderId) {
          this._systemToSender.delete(systemId);
        }
      });
  }

  private async _deliverEnvelope(
    entry: ConnectorEntry,
    envelope: FameEnvelope
  ): Promise<void> {
    const message = this._buildChannelMessage({
      envelope,
      connector: entry.connector,
      originType: entry.originType,
      systemId: entry.systemId,
    });

    try {
      await entry.connector.pushToReceive(message);
    } catch (error) {
      if (error instanceof QueueFullError) {
        logger.warning('inpage_listener_receive_queue_full', {
          system_id: entry.systemId,
        });
        return;
      }

      logger.error('inpage_listener_push_failed', {
        system_id: entry.systemId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private _buildChannelMessage(params: {
    envelope: FameEnvelope;
    connector: FameConnector;
    systemId: string;
    originType: DeliveryOriginType;
  }): FameChannelMessage {
    const context: FameDeliveryContext = {
      originType: params.originType,
      fromConnector: params.connector,
      fromSystemId: params.systemId,
      expectedResponseType: FameResponseType.NONE,
    };

    return new FameChannelMessage(params.envelope, context);
  }

  private _isNodeAttachFrame(
    frame: FameEnvelope['frame']
  ): frame is NodeAttachFrame {
    return Boolean(
      frame &&
        typeof frame === 'object' &&
        (frame as { type?: string }).type === 'NodeAttach'
    );
  }

  private _buildConnectorConfigForSystem(
    systemId: string,
    baseConfig?: ConnectorConfig | null
  ): ConnectorConfig {
    const localNodeId = this._requireLocalNodeId();
    const targetSystemId = this._normalizeNodeId(systemId);
    if (!targetSystemId) {
      throw new Error(
        'InPageListener requires a valid system id for connector creation'
      );
    }

    const candidate = baseConfig ?? null;
    const channelCandidate =
      candidate && 'channelName' in candidate
        ? (candidate as { channelName?: unknown }).channelName
        : undefined;
    const inboxCandidate =
      candidate && 'inboxCapacity' in candidate
        ? (candidate as { inboxCapacity?: unknown }).inboxCapacity
        : undefined;
    const targetCandidate =
      candidate && 'initialTargetNodeId' in candidate
        ? (candidate as { initialTargetNodeId?: unknown }).initialTargetNodeId
        : undefined;

    const channelName =
      typeof channelCandidate === 'string' && channelCandidate.trim().length > 0
        ? channelCandidate.trim()
        : this._channelName;

    const inboxCapacity =
      typeof inboxCandidate === 'number' &&
      Number.isFinite(inboxCandidate) &&
      inboxCandidate > 0
        ? Math.floor(inboxCandidate)
        : this._inboxCapacity;

    const normalizedTarget = this._normalizeTargetNodeId(targetCandidate);

    return {
      type: INPAGE_CONNECTOR_TYPE,
      channelName,
      inboxCapacity,
      localNodeId,
      initialTargetNodeId: normalizedTarget ?? targetSystemId,
    } satisfies ConnectorConfig;
  }

  private _requireLocalNodeId(): string {
    if (!this._routingNode) {
      throw new Error('InPageListener requires routing node context');
    }

    const normalized = this._normalizeNodeId(this._routingNode.id);
    if (!normalized) {
      throw new Error(
        'InPageListener requires routing node with a stable identifier'
      );
    }

    return normalized;
  }

  private _normalizeNodeId(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private _normalizeTargetNodeId(value: unknown): string | '*' | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (value === '*') {
      return '*';
    }

    return this._normalizeNodeId(value) ?? undefined;
  }
}

export function getInPageListenerInstance(): InPageListener | null {
  return _lastInPageListenerInstance;
}
