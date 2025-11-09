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
} from '@naylence/core';

const logger = getLogger('naylence.fame.connector.broadcast_channel_connector');

export const BROADCAST_CHANNEL_CONNECTOR_TYPE =
  'broadcast-channel-connector' as const;

export interface BroadcastChannelConnectorConfig extends ConnectorConfig {
  type: typeof BROADCAST_CHANNEL_CONNECTOR_TYPE;
  channelName?: string;
  inboxCapacity?: number;
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
  private listenerRegistered = false;
  private readonly connectorId: string;
  private readonly onMsg: (event: MessageEvent<unknown>) => void;
  private readonly channel: BroadcastChannel;
  private readonly seenAckKeys = new Map<string, number>();
  private readonly seenAckOrder: string[] = [];
  private readonly ackDedupTtlMs = 30_000;
  private readonly ackDedupMaxEntries = 4096;
  private readonly textDecoder = new TextDecoder();

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
    this.connectorId = BroadcastChannelConnector.generateConnectorId();
    this.channel = new BroadcastChannel(this.channelName);

    logger.debug('broadcast_channel_connector_initialized', {
      channel: this.channelName,
      connector_id: this.connectorId,
      inbox_capacity: preferredCapacity,
    });

    this.onMsg = (event: MessageEvent<unknown>): void => {
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
            return;
          }
        }

        this.inbox.enqueue(payload);
      } catch (error) {
        if (error instanceof QueueFullError) {
          logger.warning('broadcast_channel_receive_queue_full', {
            channel: this.channelName,
          });
        } else {
          logger.error('broadcast_channel_receive_error', {
            channel: this.channelName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    this.channel.addEventListener('message', this.onMsg as EventListener);
    this.listenerRegistered = true;
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
          return;
        }
      }

      this.inbox.enqueue(item);
    } catch (error) {
      if (error instanceof QueueFullError) {
        logger.warning('broadcast_channel_push_queue_full', {
          channel: this.channelName,
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
    return await this.inbox.dequeue();
  }

  protected async _transportClose(code: number, reason: string): Promise<void> {
    if (this.listenerRegistered) {
      this.channel.removeEventListener('message', this.onMsg as EventListener);
      this.listenerRegistered = false;
    }

    this.channel.close();

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
      });
      return true;
    }

    this.seenAckKeys.set(dedupKey, now);
    this.seenAckOrder.push(dedupKey);
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
