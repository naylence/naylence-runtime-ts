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
  DeliveryAckFrame,
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

type BroadcastChannelInboxItem =
  | Uint8Array
  | FameEnvelope
  | FameChannelMessage;

export class BroadcastChannelConnector extends BaseAsyncConnector {
  private readonly channelName: string;
  private readonly inbox: QueueLike<BroadcastChannelInboxItem>;
  private readonly inboxCapacity: number;
  private listenerRegistered = false;
  private readonly connectorId: string;
  private readonly onMsg: (event: MessageEvent<unknown>) => void;
  private readonly channel: BroadcastChannel;
  private readonly seenAckKeys = new Map<string, number>();
  private readonly seenAckOrder: string[] = [];
  private readonly ackDedupTtlMs = 30_000;
  private readonly ackDedupMaxEntries = 4096;
  private readonly textDecoder = new TextDecoder();
  private visibilityChangeListenerRegistered = false;
  private visibilityChangeHandler?: () => void;

  private static generateConnectorId(): string {
    const globalCrypto = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto;

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

  constructor(
    config: BroadcastChannelConnectorConfig,
    baseConfig: BaseAsyncConnectorConfig = {}
  ) {
    ensureBroadcastEnvironment();
    super(baseConfig);

    this.channelName =
      typeof config.channelName === 'string' && config.channelName.trim().length > 0
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
    this.channel = new BroadcastChannel(this.channelName);

    logger.debug('broadcast_channel_connector_created', {
      channel: this.channelName,
      connector_id: this.connectorId,
      inbox_capacity: preferredCapacity,
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
            ? (message as { constructor?: { name?: string } }).constructor?.name ?? typeof message
            : typeof message,
        has_sender_id: Boolean((message as { senderId?: unknown })?.senderId),
      });

      if (!message || typeof message !== 'object') {
        return;
      }

      const busMessage = message as { senderId?: unknown; payload?: unknown };

      if (typeof busMessage.senderId !== 'string' || busMessage.senderId.length === 0) {
        return;
      }

      if (busMessage.senderId === this.connectorId) {
        return;
      }

      const payload = BroadcastChannelConnector.coercePayload(busMessage.payload);
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
        sender_id: busMessage.senderId,
        connector_id: this.connectorId,
        payload_length: payload.byteLength,
      });

  if (this._shouldSkipDuplicateAck(busMessage.senderId, payload)) {
        return;
      }

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
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeListenerRegistered = true;
      
      // Track page lifecycle events to detect browser unload/discard
      if (typeof window !== 'undefined') {
        const lifecycleLogger = (event: Event): void => {
          logger.info('broadcast_channel_page_lifecycle', {
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

    if (this._shouldSkipDuplicateAckFromInboxItem(item)) {
      return;
    }

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
    logger.debug('broadcast_channel_message_sending', {
      channel: this.channelName,
      sender_id: this.connectorId,
    });

    this.channel.postMessage({
      senderId: this.connectorId,
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

    if (this.visibilityChangeListenerRegistered && this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
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

    this.seenAckKeys.clear();
    this.seenAckOrder.length = 0;
  }

  private _normalizeInboxItem(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): BroadcastChannelInboxItem {
    if (rawOrEnvelope instanceof Uint8Array) {
      return rawOrEnvelope;
    }

    return rawOrEnvelope;
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

  private _shouldSkipDuplicateAck(
    senderId: unknown,
    payload: Uint8Array
  ): boolean {
    const dedupKey = this._extractAckDedupKey(payload);
    if (!dedupKey) {
      return false;
    }

    const normalizedSenderId =
      typeof senderId === 'string' && senderId.length > 0
        ? senderId
        : undefined;

    if (normalizedSenderId && normalizedSenderId !== this.connectorId) {
      logger.debug('broadcast_channel_duplicate_ack_bypass_non_self', {
        channel: this.channelName,
        connector_id: this.connectorId,
        sender_id: normalizedSenderId,
        dedup_key: dedupKey,
        source: 'listener',
      });
      return false;
    }

    logger.debug('broadcast_channel_duplicate_ack_check', {
      channel: this.channelName,
      connector_id: this.connectorId,
      sender_id: normalizedSenderId ?? null,
      dedup_key: dedupKey,
      source: 'listener',
      cache_entries: this.seenAckKeys.size,
    });

    return this._checkDuplicateAck(dedupKey, normalizedSenderId);
  }

  private _shouldSkipDuplicateAckFromInboxItem(
    item: BroadcastChannelInboxItem
  ): boolean {
    if (item instanceof Uint8Array) {
      return this._shouldSkipDuplicateAck(undefined, item);
    }

    const envelope = this._extractEnvelopeFromInboxItem(item);
    if (!envelope) {
      return false;
    }

    const frame = envelope.frame as Partial<DeliveryAckFrame> | undefined;
    if (!frame || frame.type !== 'DeliveryAck') {
      return false;
    }

    const refId =
      typeof frame.refId === 'string' && frame.refId.length > 0
        ? frame.refId
        : null;
    const dedupKey = refId ?? envelope.id ?? null;
    if (!dedupKey) {
      return false;
    }

    const senderId = this._extractSenderIdFromInboxItem(item);

    if (senderId && senderId !== this.connectorId) {
      logger.debug('broadcast_channel_duplicate_ack_bypass_non_self', {
        channel: this.channelName,
        connector_id: this.connectorId,
        sender_id: senderId,
        dedup_key: dedupKey,
        source: 'inbox_item',
      });
      return false;
    }

      logger.debug('broadcast_channel_duplicate_ack_check', {
        channel: this.channelName,
        connector_id: this.connectorId,
        sender_id: senderId ?? null,
        dedup_key: dedupKey,
        source: 'inbox_item',
        cache_entries: this.seenAckKeys.size,
      });

    return this._checkDuplicateAck(dedupKey, senderId);
  }

  private _checkDuplicateAck(
    dedupKey: string,
    senderId?: string
  ): boolean {
    const now = Date.now();

    const lastSeen = this.seenAckKeys.get(dedupKey);
    if (lastSeen && now - lastSeen < this.ackDedupTtlMs) {
      logger.debug('broadcast_channel_duplicate_ack_suppressed', {
        channel: this.channelName,
        connector_id: this.connectorId,
        sender_id: senderId ?? null,
          dedup_key: dedupKey,
          age_ms: now - lastSeen,
          ttl_ms: this.ackDedupTtlMs,
          cache_entries: this.seenAckKeys.size,
      });
      return true;
    }

    this.seenAckKeys.set(dedupKey, now);
    this.seenAckOrder.push(dedupKey);
      logger.debug('broadcast_channel_duplicate_ack_recorded', {
        channel: this.channelName,
        connector_id: this.connectorId,
        sender_id: senderId ?? null,
        dedup_key: dedupKey,
        cache_entries: this.seenAckKeys.size,
      });
    this._trimSeenAcks(now);
    return false;
  }

  private _extractEnvelopeFromInboxItem(
    item: BroadcastChannelInboxItem
  ): FameEnvelope | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    if ('envelope' in (item as FameChannelMessage)) {
      return (item as FameChannelMessage).envelope;
    }

    if ('frame' in (item as FameEnvelope)) {
      return item as FameEnvelope;
    }

    return null;
  }

  private _extractSenderIdFromInboxItem(
    item: BroadcastChannelInboxItem
  ): string | undefined {
    if (!item || typeof item !== 'object') {
      return undefined;
    }

    if ('context' in (item as FameChannelMessage)) {
      const context = (item as FameChannelMessage).context;
      if (context && typeof context.fromSystemId === 'string') {
        return context.fromSystemId;
      }
    }

    return undefined;
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

  private _trimSeenAcks(now: number): void {
    while (this.seenAckOrder.length > 0) {
      const candidate = this.seenAckOrder[0];
      const timestamp = this.seenAckKeys.get(candidate);

      if (timestamp === undefined) {
        this.seenAckOrder.shift();
        continue;
      }

      if (
        this.seenAckKeys.size > this.ackDedupMaxEntries ||
        now - timestamp > this.ackDedupTtlMs
      ) {
        this.seenAckKeys.delete(candidate);
        this.seenAckOrder.shift();
        continue;
      }

      break;
    }
  }

  private _extractAckDedupKey(payload: Uint8Array): string | null {
    try {
      const decoded = this.textDecoder.decode(payload);
      const parsed = JSON.parse(decoded) as {
        id?: unknown;
        frame?: Partial<DeliveryAckFrame> & { type?: unknown };
      };
      const envelopeId = typeof parsed?.id === 'string' ? parsed.id : null;

      const frameType = parsed?.frame?.type;
      if (typeof frameType !== 'string' || frameType !== 'DeliveryAck') {
        return null;
      }

      const refId = parsed.frame?.refId;
      if (typeof refId === 'string' && refId.length > 0) {
        return refId;
      }

      return envelopeId;
    } catch (error) {
      logger.debug('broadcast_channel_ack_dedup_parse_failed', {
        channel: this.channelName,
        connector_id: this.connectorId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
