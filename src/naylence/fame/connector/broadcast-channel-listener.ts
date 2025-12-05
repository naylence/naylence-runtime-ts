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
import { ZodError } from 'zod';

import { TransportListener } from './transport-listener.js';
import type { NodeLike } from '../node/node-like.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import { getLogger } from '../util/logging.js';
import { GRANT_PURPOSE_NODE_ATTACH } from '../grants/grant.js';
import {
  BROADCAST_CHANNEL_CONNECTOR_TYPE,
  type BroadcastChannelConnectorConfig,
} from './broadcast-channel-connector.js';
import type { ConnectorConfig } from './connector-config.js';
import {
  GrantSelectionContext,
  defaultGrantSelectionPolicy,
} from './grant-selection-policy.js';
import type { ConnectionGrant } from '../grants/connection-grant.js';
import { QueueFullError } from '../util/bounded-async-queue.js';
import {
  BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
  broadcastChannelGrantToConnectorConfig,
  type BroadcastChannelConnectorConfigLike,
  type BroadcastChannelConnectionGrantLike,
} from '../grants/broadcast-channel-connection-grant.js';

const logger = getLogger('naylence.fame.connector.broadcast_channel_listener');

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

const RESPONSE_TYPE_MASK =
  FameResponseType.ACK | FameResponseType.REPLY | FameResponseType.STREAM;

const isBrowserEnvironment = (): boolean =>
  typeof window !== 'undefined' &&
  typeof BroadcastChannel !== 'undefined' &&
  typeof MessageEvent !== 'undefined';

const ensureBrowserEnvironment = (): void => {
  if (!isBrowserEnvironment()) {
    throw new Error(
      'BroadcastChannelListener is browser-only and requires BroadcastChannel support'
    );
  }
};

export interface BroadcastChannelListenerOptions {
  channelName?: string;
  inboxCapacity?: number;
}

let _lastBroadcastChannelListenerInstance: BroadcastChannelListener | null =
  null;

interface ConnectorEntry {
  connector: FameConnector;
  systemId: string;
  originType: DeliveryOriginType;
}

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

export class BroadcastChannelListener extends TransportListener {
  private readonly _channelName: string;
  private readonly _inboxCapacity: number;
  private _isRunning = false;
  private _initialized = false;
  private _routingNode: RoutingNodeLike | null = null;
  private _channel: BroadcastChannel | null = null;
  private _channelHandler: ((event: MessageEvent<unknown>) => void) | null =
    null;
  private readonly _senderRegistry = new Map<string, ConnectorEntry>();
  private readonly _systemToSender = new Map<string, string>();
  private readonly _pendingAttachments = new Map<
    string,
    Promise<ConnectorEntry | null>
  >();

  constructor(options?: BroadcastChannelListenerOptions) {
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

    _lastBroadcastChannelListenerInstance = this;
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

    logger.debug('broadcast_channel_listener_initialized', {
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
      this._registerChannelListener();
    } else {
      logger.warning('broadcast_channel_listener_missing_routing_capability');
    }

    this._isRunning = true;

    logger.debug('broadcast_channel_listener_started', {
      channel: this._channelName,
    });
  }

  async onNodeStopped(_node: NodeLike): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    this._isRunning = false;
    this._unregisterChannelListener();
    this._senderRegistry.clear();
    this._systemToSender.clear();
    this._pendingAttachments.clear();

    logger.debug('broadcast_channel_listener_stopped', {
      channel: this._channelName,
    });
  }

  override getCallbackGrant(): Record<string, unknown> | null {
    return this.withLegacySnakeCaseKeys({
      type: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      channelName: this._channelName,
      inboxCapacity: this._inboxCapacity,
    });
  }

  override asCallbackGrant(): Record<string, unknown> | null {
    return this.withLegacySnakeCaseKeys({
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
      connectorType: BROADCAST_CHANNEL_CONNECTOR_TYPE,
      connectionGrantType: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
      channelName: this._channelName,
      inboxCapacity: this._inboxCapacity,
    });
  }

  private _registerChannelListener(): void {
    if (this._channelHandler) {
      return;
    }

    ensureBrowserEnvironment();

    const channel = new BroadcastChannel(this._channelName);
    const handler = (event: MessageEvent<unknown>): void => {
      void this._handleChannelEvent(event);
    };

    channel.addEventListener('message', handler as EventListener);

    this._channel = channel;
    this._channelHandler = handler;
  }

  private _unregisterChannelListener(): void {
    if (!this._channel || !this._channelHandler) {
      return;
    }

    this._channel.removeEventListener(
      'message',
      this._channelHandler as EventListener
    );
    this._channel.close();
    this._channel = null;
    this._channelHandler = null;
  }

  private async _handleChannelEvent(
    event: MessageEvent<unknown>
  ): Promise<void> {
    if (!this._routingNode) {
      return;
    }

    const normalized = this._parseChannelEvent(event);
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
      logger.debug('broadcast_channel_listener_no_connector_for_sender', {
        sender_id: senderId,
        frame_type: envelope.frame?.type ?? 'unknown',
      });
      return;
    }

    await this._deliverEnvelope(entry, envelope);
  }

  private _parseChannelEvent(
    event: MessageEvent<unknown>
  ): { senderId: string; envelope: FameEnvelope } | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const payloadContainer = event.data;
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
      logger.debug('broadcast_channel_listener_ignored_event_without_payload', {
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
      const decoded = (() => {
        try {
          return new TextDecoder().decode(payload);
        } catch {
          return null;
        }
      })();

      if (error instanceof ZodError && decoded && decoded.length > 0) {
        try {
          const reparsed = JSON.parse(decoded) as Record<string, unknown>;
          const candidate = reparsed.rtype;

          if (
            typeof candidate === 'number' &&
            (candidate & ~RESPONSE_TYPE_MASK) === 0
          ) {
            const sanitized = { ...reparsed } as Record<string, unknown>;
            delete sanitized.rtype;

            const baseEnvelope = deserializeEnvelope(sanitized);
            envelope = {
              ...baseEnvelope,
              rtype: candidate as FameResponseType,
            };

            logger.debug(
              'broadcast_channel_listener_envelope_rtype_bitmask_coerced',
              {
                sender_id: senderId,
                rtype: candidate,
              }
            );

            return { senderId, envelope };
          }
        } catch (fallbackError) {
          logger.debug('broadcast_channel_listener_envelope_parse_failed', {
            sender_id: senderId,
            error:
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError),
            raw_payload: decoded,
          });
          return null;
        }
      }

      logger.debug('broadcast_channel_listener_envelope_parse_failed', {
        sender_id: senderId,
        error: error instanceof Error ? error.message : String(error),
        raw_payload: decoded ?? '<un-decodable>',
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
      logger.warning('broadcast_channel_listener_attach_missing_system_id', {
        sender_id: senderId,
      });
      return;
    }

    logger.debug('broadcast_channel_listener_attach_frame_received', {
      sender_id: senderId,
      fields: Object.keys(frame ?? {}),
    });

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

    let connectorConfig: BroadcastChannelConnectorConfig | null = null;

    try {
      const selectionContext = new GrantSelectionContext({
        childId: systemId,
        attachFrame: frame,
        callbackGrantType: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
        node: routingNode,
      });

      const selection =
        defaultGrantSelectionPolicy.selectCallbackGrant(selectionContext);
      connectorConfig = this._grantToConnectorConfig(selection.grant, systemId);
    } catch (error) {
      logger.debug('broadcast_channel_listener_grant_selection_failed', {
        sender_id: params.senderId,
        system_id: systemId,
        error: error instanceof Error ? error.message : String(error),
      });

      connectorConfig =
        this._extractBroadcastConnectorConfig(frame, systemId) ??
        this._buildConnectorConfigForSystem(systemId, {
          type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
          channelName: this._channelName,
          inboxCapacity: this._inboxCapacity,
          passive: true,
        });
    }

    if (!connectorConfig) {
      logger.error('broadcast_channel_listener_missing_connector_config', {
        sender_id: params.senderId,
        system_id: systemId,
      });
      return null;
    }

    try {
      const connector = await routingNode.createOriginConnector({
        originType,
        systemId,
        connectorConfig,
      });

      this._monitorConnectorLifecycle(params.senderId, systemId, connector);

      logger.debug('broadcast_channel_listener_created_connector', {
        sender_id: params.senderId,
        system_id: systemId,
        origin_type: originType,
        connector_type: connector.constructor?.name ?? 'unknown',
      });

      return { connector, systemId, originType };
    } catch (error) {
      logger.error('broadcast_channel_listener_connector_creation_failed', {
        sender_id: params.senderId,
        system_id: systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private _extractBroadcastConnectorConfig(
    frame: NodeAttachFrame,
    systemId: string
  ): BroadcastChannelConnectorConfig | null {
    const rawGrants = frame.callbackGrants as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(rawGrants)) {
      return null;
    }

    for (const grant of rawGrants) {
      if (
        grant &&
        typeof grant === 'object' &&
        (grant.type === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE ||
          grant.type === BROADCAST_CHANNEL_CONNECTOR_TYPE)
      ) {
        try {
          if (grant.type === BROADCAST_CHANNEL_CONNECTOR_TYPE) {
            return this._buildConnectorConfigForSystem(
              systemId,
              grant as BroadcastChannelConnectorConfigLike
            );
          }

          return this._buildConnectorConfigForSystem(
            systemId,
            broadcastChannelGrantToConnectorConfig(
              grant as BroadcastChannelConnectionGrantLike
            )
          );
        } catch (error) {
          logger.debug(
            'broadcast_channel_listener_grant_normalization_failed',
            {
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }
    }

    return null;
  }

  private _grantToConnectorConfig(
    grant: ConnectionGrant,
    systemId: string
  ): BroadcastChannelConnectorConfig {
    if (grant.type === BROADCAST_CHANNEL_CONNECTOR_TYPE) {
      return this._buildConnectorConfigForSystem(
        systemId,
        grant as BroadcastChannelConnectorConfigLike
      );
    }

    if (grant.type === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE) {
      return this._buildConnectorConfigForSystem(
        systemId,
        broadcastChannelGrantToConnectorConfig(
          grant as BroadcastChannelConnectionGrantLike
        )
      );
    }

    if (
      'toConnectorConfig' in grant &&
      typeof (grant as { toConnectorConfig?: unknown }).toConnectorConfig ===
        'function'
    ) {
      const normalized = (
        grant as { toConnectorConfig: () => ConnectorConfig }
      ).toConnectorConfig();
      if (normalized.type !== BROADCAST_CHANNEL_CONNECTOR_TYPE) {
        throw new Error(`Unsupported grant connector type: ${normalized.type}`);
      }

      return this._buildConnectorConfigForSystem(
        systemId,
        normalized as BroadcastChannelConnectorConfigLike
      );
    }

    throw new Error(`Unsupported grant type: ${grant.type}`);
  }

  private _buildConnectorConfigForSystem(
    systemId: string,
    baseConfig?: BroadcastChannelConnectorConfigLike | ConnectorConfig | null
  ): BroadcastChannelConnectorConfig {
    const localNodeId = this._requireLocalNodeId();
    const targetSystemId = this._normalizeNodeId(systemId);
    if (!targetSystemId) {
      throw new Error('BroadcastChannelListener requires a valid system id');
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
    const initialWindowCandidate =
      candidate && 'initialWindow' in candidate
        ? (candidate as { initialWindow?: unknown }).initialWindow
        : undefined;
    const passiveCandidate =
      candidate && 'passive' in candidate
        ? (candidate as { passive?: unknown }).passive
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

    const initialWindow =
      typeof initialWindowCandidate === 'number' &&
      Number.isFinite(initialWindowCandidate) &&
      initialWindowCandidate > 0
        ? Math.floor(initialWindowCandidate)
        : undefined;

    const initialTargetNodeId =
      this._normalizeNodeId(targetCandidate) ?? targetSystemId;

    const passive =
      typeof passiveCandidate === 'boolean' ? passiveCandidate : true;

    logger.debug('broadcast_channel_listener_building_connector_config', {
      system_id: systemId,
      channel_name: channelName,
      passive,
      has_base_config: !!baseConfig,
      passive_candidate: passiveCandidate,
    });

    return {
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
      channelName,
      inboxCapacity,
      passive,
      initialWindow,
      localNodeId,
      initialTargetNodeId,
    } satisfies BroadcastChannelConnectorConfig;
  }

  private _requireLocalNodeId(): string {
    if (!this._routingNode) {
      throw new Error('BroadcastChannelListener requires routing node context');
    }

    const normalized = this._normalizeNodeId(this._routingNode.id);

    if (!normalized) {
      throw new Error(
        'BroadcastChannelListener requires routing node with a stable identifier'
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
        logger.debug('broadcast_channel_listener_wait_until_closed_failed', {
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
        logger.warning('broadcast_channel_listener_receive_queue_full', {
          system_id: entry.systemId,
        });
        return;
      }

      logger.error('broadcast_channel_listener_push_failed', {
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
}

export function getBroadcastChannelListenerInstance(): BroadcastChannelListener | null {
  return _lastBroadcastChannelListenerInstance;
}
