import {
  BaseAsyncConnector,
  type BaseAsyncConnectorConfig,
} from './base-async-connector.js';
import type { ConnectorConfig } from './connector-config.js';
import { FameTransportClose } from '../errors/errors.js';
import { getLogger } from '../util/logging.js';
import {
  BoundedAsyncQueue,
  QueueFullError,
} from '../util/bounded-async-queue.js';
import type {
  FameEnvelope,
  FameChannelMessage,
  FameEnvelopeHandler,
} from '@naylence/core';
import { ConnectorState } from '@naylence/core';

const logger = getLogger('naylence.fame.connector.broadcast_channel_connector');

export const BROADCAST_CHANNEL_CONNECTOR_TYPE =
  'broadcast-channel-connector' as const;

export interface BroadcastChannelConnectorConfig extends ConnectorConfig {
  type: typeof BROADCAST_CHANNEL_CONNECTOR_TYPE;
  channelName?: string;
  inboxCapacity?: number;
  initialWindow?: number;
  passive?: boolean;
  localNodeId: string;
  initialTargetNodeId?: string | '*';
}

type QueueLike<T> = BoundedAsyncQueue<T> & {
  tryEnqueue?: (item: T) => boolean;
};

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

const isBrowserEnvironment = (): boolean =>
  typeof window !== 'undefined' &&
  typeof BroadcastChannel !== 'undefined' &&
  typeof MessageEvent !== 'undefined';

const ensureBroadcastEnvironment = (): void => {
  if (!isBrowserEnvironment()) {
    throw new Error(
      'BroadcastChannelConnector is browser-only and requires BroadcastChannel support'
    );
  }
};

type BroadcastChannelInboxItem = Uint8Array | FameEnvelope | FameChannelMessage;

type BroadcastBusMessage = {
  senderId?: unknown;
  senderNodeId?: unknown;
  targetNodeId?: unknown;
  payload?: unknown;
};

export class BroadcastChannelConnector extends BaseAsyncConnector {
  private readonly channelName: string;
  private readonly inbox: QueueLike<BroadcastChannelInboxItem>;
  private readonly inboxCapacity: number;
  private listenerRegistered = false;
  private readonly connectorId: string;
  private readonly localNodeId: string;
  private targetNodeId?: string | '*';
  private readonly onMsg: (event: MessageEvent<unknown>) => void;
  private readonly channel: BroadcastChannel;
  private visibilityChangeListenerRegistered = false;
  private visibilityChangeHandler?: () => void;

  private static generateConnectorId(): string {
    const globalCrypto = (globalThis as typeof globalThis & { crypto?: Crypto })
      .crypto;

    if (globalCrypto?.randomUUID) {
      return globalCrypto.randomUUID();
    }

    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }

  private static coercePayload(raw: unknown): Uint8Array | null {
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
  }

  private static normalizeNodeId(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private static normalizeTargetNodeId(
    value: unknown
  ): string | '*' | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    if (trimmed === '*') {
      return '*';
    }

    return trimmed;
  }

  constructor(
    config: BroadcastChannelConnectorConfig,
    baseConfig: BaseAsyncConnectorConfig = {}
  ) {
    ensureBroadcastEnvironment();
    super(baseConfig);

    this.channelName =
      typeof config.channelName === 'string' &&
      config.channelName.trim().length > 0
        ? config.channelName.trim()
        : DEFAULT_CHANNEL;

    const preferredCapacity =
      typeof config.inboxCapacity === 'number' &&
      Number.isFinite(config.inboxCapacity) &&
      config.inboxCapacity > 0
        ? Math.floor(config.inboxCapacity)
        : DEFAULT_INBOX_CAPACITY;

    this.inbox = new BoundedAsyncQueue<BroadcastChannelInboxItem>(
      preferredCapacity
    ) as QueueLike<BroadcastChannelInboxItem>;
    this.inboxCapacity = preferredCapacity;
    this.connectorId = BroadcastChannelConnector.generateConnectorId();
    const normalizedLocalNodeId = BroadcastChannelConnector.normalizeNodeId(
      config.localNodeId
    );

    if (!normalizedLocalNodeId) {
      throw new Error(
        'BroadcastChannelConnector requires a non-empty localNodeId'
      );
    }

    this.localNodeId = normalizedLocalNodeId;
    this.targetNodeId = BroadcastChannelConnector.normalizeTargetNodeId(
      config.initialTargetNodeId
    );
    this.channel = new BroadcastChannel(this.channelName);

    logger.debug('broadcast_channel_connector_created', {
      channel: this.channelName,
      connector_id: this.connectorId,
      local_node_id: this.localNodeId,
      target_node_id: this.targetNodeId ?? null,
      inbox_capacity: preferredCapacity,
      passive: config.passive ?? false,
      timestamp: new Date().toISOString(),
    });

    this.onMsg = (event: MessageEvent<unknown>): void => {
      // Guard: Don't process if listener was unregistered
      if (!this.listenerRegistered) {
        logger.warning('broadcast_channel_message_after_unregister', {
          channel: this.channelName,
          connector_id: this.connectorId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const message = event.data;

      logger.debug('broadcast_channel_raw_event', {
        channel: this.channelName,
        connector_id: this.connectorId,
        message_type:
          message && typeof message === 'object'
            ? ((message as { constructor?: { name?: string } }).constructor
                ?.name ?? typeof message)
            : typeof message,
        has_sender_id: Boolean((message as { senderId?: unknown })?.senderId),
        has_sender_node_id: Boolean(
          (message as { senderNodeId?: unknown })?.senderNodeId
        ),
      });

      if (!message || typeof message !== 'object') {
        return;
      }

      const busMessage = message as BroadcastBusMessage;

      const senderNodeId = BroadcastChannelConnector.normalizeNodeId(
        busMessage.senderNodeId
      );
      if (!senderNodeId) {
        logger.debug('broadcast_channel_message_rejected', {
          channel: this.channelName,
          connector_id: this.connectorId,
          reason: 'missing_sender_node_id',
        });
        return;
      }

      if (senderNodeId === this.localNodeId) {
        logger.debug('broadcast_channel_message_rejected', {
          channel: this.channelName,
          connector_id: this.connectorId,
          reason: 'self_echo',
          sender_node_id: senderNodeId,
        });
        return;
      }

      const incomingTargetNodeId =
        BroadcastChannelConnector.normalizeTargetNodeId(
          busMessage.targetNodeId
        );

      if (
        !this._shouldAcceptMessageFromBus(senderNodeId, incomingTargetNodeId)
      ) {
        return;
      }

      const payload = BroadcastChannelConnector.coercePayload(
        busMessage.payload
      );
      if (!payload) {
        logger.debug('broadcast_channel_payload_rejected', {
          channel: this.channelName,
          connector_id: this.connectorId,
          reason: 'unrecognized_payload_type',
        });
        return;
      }

      logger.debug('broadcast_channel_message_received', {
        channel: this.channelName,
        sender_id: (message as { senderId?: unknown })?.senderId,
        sender_node_id: senderNodeId,
        target_node_id: incomingTargetNodeId ?? null,
        connector_id: this.connectorId,
        payload_length: payload.byteLength,
      });

      try {
        if (typeof this.inbox.tryEnqueue === 'function') {
          const accepted = this.inbox.tryEnqueue(payload);
          if (accepted) {
            this.logInboxSnapshot('broadcast_channel_inbox_enqueued', {
              source: 'listener',
              enqueue_strategy: 'try',
              payload_length: payload.byteLength,
            });
            return;
          }
        }

        this.inbox.enqueue(payload);
        this.logInboxSnapshot('broadcast_channel_inbox_enqueued', {
          source: 'listener',
          enqueue_strategy: 'enqueue',
          payload_length: payload.byteLength,
        });
      } catch (error) {
        if (error instanceof QueueFullError) {
          logger.warning('broadcast_channel_receive_queue_full', {
            channel: this.channelName,
            inbox_capacity: this.inboxCapacity,
            inbox_remaining_capacity: this.inbox.remainingCapacity,
          });
        } else {
          logger.error('broadcast_channel_receive_error', {
            channel: this.channelName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    if (!config.passive) {
      this.channel.addEventListener('message', this.onMsg as EventListener);
      this.listenerRegistered = true;
    }

    // Setup visibility change monitoring
    this.visibilityChangeHandler = (): void => {
      const isHidden = document.hidden;
      logger.debug('broadcast_channel_visibility_changed', {
        channel: this.channelName,
        connector_id: this.connectorId,
        visibility: isHidden ? 'hidden' : 'visible',
        timestamp: new Date().toISOString(),
      });

      // Pause/resume connector based on visibility
      if (isHidden && this.state === ConnectorState.STARTED) {
        this.pause().catch((err) => {
          logger.warning('broadcast_channel_pause_failed', {
            channel: this.channelName,
            connector_id: this.connectorId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else if (!isHidden && this.state === ConnectorState.PAUSED) {
        this.resume().catch((err) => {
          logger.warning('broadcast_channel_resume_failed', {
            channel: this.channelName,
            connector_id: this.connectorId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener(
        'visibilitychange',
        this.visibilityChangeHandler
      );
      this.visibilityChangeListenerRegistered = true;

      // Track page lifecycle events to detect browser unload/discard
      if (typeof window !== 'undefined') {
        const lifecycleLogger = (event: Event): void => {
          logger.debug('broadcast_channel_page_lifecycle', {
            channel: this.channelName,
            connector_id: this.connectorId,
            event_type: event.type,
            visibility_state: document.visibilityState,
            timestamp: new Date().toISOString(),
          });
        };

        window.addEventListener('beforeunload', lifecycleLogger);
        window.addEventListener('unload', lifecycleLogger);
        window.addEventListener('pagehide', lifecycleLogger);
        window.addEventListener('pageshow', lifecycleLogger);
        document.addEventListener('freeze', lifecycleLogger);
        document.addEventListener('resume', lifecycleLogger);
      }

      // Log initial state with detailed visibility info
      logger.debug('broadcast_channel_initial_visibility', {
        channel: this.channelName,
        connector_id: this.connectorId,
        visibility: document.hidden ? 'hidden' : 'visible',
        document_hidden: document.hidden,
        visibility_state: document.visibilityState,
        has_focus: document.hasFocus(),
        timestamp: new Date().toISOString(),
      });
    }
  }

  async pushToReceive(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): Promise<void> {
    const item = this._normalizeInboxItem(rawOrEnvelope);

    try {
      if (typeof this.inbox.tryEnqueue === 'function') {
        const accepted = this.inbox.tryEnqueue(item);
        if (accepted) {
          this.logInboxSnapshot('broadcast_channel_push_enqueued', {
            enqueue_strategy: 'try',
            item_type: this._describeInboxItem(item),
          });
          return;
        }
      }

      this.inbox.enqueue(item);
      this.logInboxSnapshot('broadcast_channel_push_enqueued', {
        enqueue_strategy: 'enqueue',
        item_type: this._describeInboxItem(item),
      });
    } catch (error) {
      if (error instanceof QueueFullError) {
        logger.warning('broadcast_channel_push_queue_full', {
          channel: this.channelName,
          inbox_capacity: this.inboxCapacity,
          inbox_remaining_capacity: this.inbox.remainingCapacity,
        });
        throw error;
      }

      logger.error('broadcast_channel_push_failed', {
        channel: this.channelName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  protected async _transportSendBytes(data: Uint8Array): Promise<void> {
    ensureBroadcastEnvironment();
    const targetNodeId = this.targetNodeId ?? '*';
    logger.debug('broadcast_channel_message_sending', {
      channel: this.channelName,
      sender_id: this.connectorId,
      sender_node_id: this.localNodeId,
      target_node_id: targetNodeId,
    });

    this.channel.postMessage({
      senderId: this.connectorId,
      senderNodeId: this.localNodeId,
      targetNodeId,
      payload: data,
    });
  }

  protected async _transportReceive(): Promise<BroadcastChannelInboxItem> {
    const item = await this.inbox.dequeue();
    this.logInboxSnapshot('broadcast_channel_inbox_dequeued', {
      item_type: this._describeInboxItem(item),
    });
    return item;
  }

  protected async _transportClose(code: number, reason: string): Promise<void> {
    logger.debug('broadcast_channel_transport_closing', {
      channel: this.channelName,
      connector_id: this.connectorId,
      code,
      reason,
      listener_registered: this.listenerRegistered,
      timestamp: new Date().toISOString(),
    });

    if (this.listenerRegistered) {
      logger.debug('broadcast_channel_removing_listener', {
        channel: this.channelName,
        connector_id: this.connectorId,
        timestamp: new Date().toISOString(),
      });
      this.channel.removeEventListener('message', this.onMsg as EventListener);
      this.listenerRegistered = false;
      logger.debug('broadcast_channel_listener_removed', {
        channel: this.channelName,
        connector_id: this.connectorId,
        timestamp: new Date().toISOString(),
      });
    }

    if (
      this.visibilityChangeListenerRegistered &&
      this.visibilityChangeHandler &&
      typeof document !== 'undefined'
    ) {
      document.removeEventListener(
        'visibilitychange',
        this.visibilityChangeHandler
      );
      this.visibilityChangeListenerRegistered = false;
      this.visibilityChangeHandler = undefined;
    }

    logger.debug('broadcast_channel_closing', {
      channel: this.channelName,
      connector_id: this.connectorId,
      timestamp: new Date().toISOString(),
    });
    this.channel.close();
    logger.debug('broadcast_channel_closed', {
      channel: this.channelName,
      connector_id: this.connectorId,
      timestamp: new Date().toISOString(),
    });

    const closeCode = typeof code === 'number' ? code : 1000;
    const closeReason =
      typeof reason === 'string' && reason.length > 0 ? reason : 'closed';
    const shutdownError = new FameTransportClose(closeReason, closeCode);
    this.inbox.drain(shutdownError);
  }

  private _normalizeInboxItem(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): BroadcastChannelInboxItem {
    if (rawOrEnvelope instanceof Uint8Array) {
      return rawOrEnvelope;
    }

    return rawOrEnvelope;
  }

  private _isWildcardTarget(): boolean {
    return (
      this.targetNodeId === '*' || typeof this.targetNodeId === 'undefined'
    );
  }

  private _shouldAcceptMessageFromBus(
    senderNodeId: string,
    targetNodeId: string | '*' | undefined
  ): boolean {
    if (this._isWildcardTarget()) {
      if (
        targetNodeId &&
        targetNodeId !== '*' &&
        targetNodeId !== this.localNodeId
      ) {
        logger.debug('broadcast_channel_message_rejected', {
          channel: this.channelName,
          connector_id: this.connectorId,
          reason: 'wildcard_target_mismatch',
          sender_node_id: senderNodeId,
          target_node_id: targetNodeId,
          local_node_id: this.localNodeId,
        });
        return false;
      }

      return true;
    }

    const expectedSender = this.targetNodeId;
    if (
      expectedSender &&
      expectedSender !== '*' &&
      senderNodeId !== expectedSender
    ) {
      logger.debug('broadcast_channel_message_rejected', {
        channel: this.channelName,
        connector_id: this.connectorId,
        reason: 'unexpected_sender',
        expected_sender_node_id: expectedSender,
        sender_node_id: senderNodeId,
        local_node_id: this.localNodeId,
      });
      return false;
    }

    if (
      targetNodeId &&
      targetNodeId !== '*' &&
      targetNodeId !== this.localNodeId
    ) {
      logger.debug('broadcast_channel_message_rejected', {
        channel: this.channelName,
        connector_id: this.connectorId,
        reason: 'unexpected_target',
        sender_node_id: senderNodeId,
        target_node_id: targetNodeId,
        local_node_id: this.localNodeId,
      });
      return false;
    }

    return true;
  }

  private _describeInboxItem(item: BroadcastChannelInboxItem): string {
    if (item instanceof Uint8Array) {
      return 'bytes';
    }

    if ((item as FameChannelMessage).envelope) {
      return 'channel_message';
    }

    if ((item as FameEnvelope).frame) {
      return 'envelope';
    }

    return 'unknown';
  }

  private logInboxSnapshot(
    event: string,
    extra: Record<string, unknown> = {}
  ): void {
    logger.debug(event, {
      channel: this.channelName,
      connector_id: this.connectorId,
      connector_state: this.state,
      inbox_capacity: this.inboxCapacity,
      inbox_remaining_capacity: this.inbox.remainingCapacity,
      ...extra,
    });
  }

  /**
   * Override start() to check initial visibility state
   */
  async start(inboundHandler: FameEnvelopeHandler): Promise<void> {
    await super.start(inboundHandler);

    // After transitioning to STARTED, check if tab is already hidden
    if (typeof document !== 'undefined' && document.hidden) {
      logger.debug('broadcast_channel_start_in_hidden_tab', {
        channel: this.channelName,
        connector_id: this.connectorId,
        document_hidden: document.hidden,
        visibility_state: document.visibilityState,
        has_focus: document.hasFocus(),
        timestamp: new Date().toISOString(),
      });

      // Immediately pause if tab is hidden at start time
      await this.pause().catch((err) => {
        logger.warning('broadcast_channel_initial_pause_failed', {
          channel: this.channelName,
          connector_id: this.connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  setTargetNodeId(nodeId: string): void {
    const normalized = BroadcastChannelConnector.normalizeNodeId(nodeId);
    if (!normalized) {
      throw new Error(
        'BroadcastChannelConnector target node id must be a non-empty string'
      );
    }

    if (normalized === '*') {
      this.setWildcardTarget();
      return;
    }

    this.targetNodeId = normalized;
    logger.debug('broadcast_channel_target_updated', {
      channel: this.channelName,
      connector_id: this.connectorId,
      local_node_id: this.localNodeId,
      target_node_id: this.targetNodeId,
      target_mode: 'direct',
    });
  }

  setWildcardTarget(): void {
    this.targetNodeId = '*';
    logger.debug('broadcast_channel_target_updated', {
      channel: this.channelName,
      connector_id: this.connectorId,
      local_node_id: this.localNodeId,
      target_node_id: this.targetNodeId,
      target_mode: 'wildcard',
    });
  }
}
