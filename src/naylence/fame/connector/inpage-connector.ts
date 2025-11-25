/**
 * Browser-local connector that routes binary frames between peers via an in-page EventTarget.
 * Relies on BaseAsyncConnector for flow control and shutdown behavior.
 */
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
import type { FameEnvelope, FameChannelMessage, FameEnvelopeHandler } from '@naylence/core';
import { ConnectorState } from '@naylence/core';

const logger = getLogger('naylence.fame.connector.inpage_connector');

export const INPAGE_CONNECTOR_TYPE = 'inpage-connector' as const;

export interface InPageConnectorConfig extends ConnectorConfig {
  type: typeof INPAGE_CONNECTOR_TYPE;
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
  typeof document !== 'undefined' &&
  typeof EventTarget !== 'undefined' &&
  typeof MessageEvent !== 'undefined';

const ensureBrowserEnvironment = (): void => {
  if (!isBrowserEnvironment()) {
    throw new Error('InPageConnector is browser-only and requires DOM EventTarget support');
  }
};

const getSharedBus = (): EventTarget => {
  ensureBrowserEnvironment();

  const globalWithBus = globalThis as typeof globalThis & {
    __naylence_inpage_bus__?: EventTarget;
  };

  if (!globalWithBus.__naylence_inpage_bus__) {
    // Share a single in-page bus across all module instances (esm/cjs, realms).
    globalWithBus.__naylence_inpage_bus__ = new EventTarget();
  }

  return globalWithBus.__naylence_inpage_bus__ as EventTarget;
};

type InPageInboxItem = Uint8Array | FameEnvelope | FameChannelMessage;

export class InPageConnector extends BaseAsyncConnector {
  private readonly channelName: string;
  private readonly inbox: QueueLike<InPageInboxItem>;
  private listenerRegistered = false;
  private readonly connectorId: string;
  private readonly onMsg: (event: Event) => void;
  private visibilityChangeListenerRegistered = false;
  private visibilityChangeHandler?: () => void;

  private static generateConnectorId(): string {
    const globalCrypto = (globalThis as typeof globalThis & {
      crypto?: Crypto;
    }).crypto;

    if (globalCrypto?.randomUUID) {
      return globalCrypto.randomUUID();
    }

    // Fallback for environments without crypto.randomUUID
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
        return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      }
    }

    if (Array.isArray(raw) && raw.every((item) => typeof item === 'number')) {
      return Uint8Array.from(raw as number[]);
    }

    return null;
  }

  constructor(
    config: InPageConnectorConfig,
    baseConfig: BaseAsyncConnectorConfig = {}
  ) {
    ensureBrowserEnvironment();
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

  this.inbox = new BoundedAsyncQueue<InPageInboxItem>(preferredCapacity) as QueueLike<InPageInboxItem>;
    this.connectorId = InPageConnector.generateConnectorId();

    logger.debug('inpage_connector_initialized', {
      channel: this.channelName,
      connector_id: this.connectorId,
    });

    this.onMsg = (event: Event): void => {
      const messageEvent = event as MessageEvent<unknown>;
      const message = messageEvent.data;

      logger.debug('inpage_raw_event', {
        channel: this.channelName,
        connector_id: this.connectorId,
        message_type: message && typeof message === 'object' ? (message as { constructor?: { name?: string } }).constructor?.name ?? typeof message : typeof message,
        has_sender_id: Boolean((message as { senderId?: unknown })?.senderId),
        payload_type:
          message && typeof message === 'object'
            ? (message as { payload?: unknown })?.payload instanceof Uint8Array
              ? 'Uint8Array'
              : (message as { payload?: unknown })?.payload instanceof ArrayBuffer
                ? 'ArrayBuffer'
                : typeof (message as { payload?: unknown })?.payload
            : typeof message,
        payload_constructor:
          message && typeof message === 'object'
            ? (message as { payload?: { constructor?: { name?: string } } })?.payload?.constructor?.name
            : undefined,
        payload_keys:
          message && typeof message === 'object' && (message as { payload?: unknown })?.payload && typeof (message as { payload?: unknown })?.payload === 'object'
            ? Object.keys((message as { payload?: Record<string, unknown> }).payload as Record<string, unknown>).slice(0, 5)
            : undefined,
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

      const payload = InPageConnector.coercePayload(busMessage.payload);
      if (!payload) {
        logger.debug('inpage_payload_rejected', {
          channel: this.channelName,
          connector_id: this.connectorId,
          reason: 'unrecognized_payload_type',
        });
        return;
      }

      logger.debug('inpage_message_received', {
        channel: this.channelName,
        sender_id: busMessage.senderId,
        connector_id: this.connectorId,
        payload_length: payload.byteLength,
      });

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
          logger.warning('inpage_receive_queue_full', {
            channel: this.channelName,
          });
        } else {
          logger.error('inpage_receive_error', {
            channel: this.channelName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    getSharedBus().addEventListener(this.channelName, this.onMsg as EventListener);
    this.listenerRegistered = true;

    // Setup visibility change monitoring
    this.visibilityChangeHandler = (): void => {
      const isHidden = document.hidden;
      logger.debug('inpage_visibility_changed', {
        channel: this.channelName,
        connector_id: this.connectorId,
        visibility: isHidden ? 'hidden' : 'visible',
        timestamp: new Date().toISOString(),
      });

      // Pause/resume connector based on visibility
      if (isHidden && this.state === ConnectorState.STARTED) {
        this.pause().catch((err) => {
          logger.warning('inpage_pause_failed', {
            channel: this.channelName,
            connector_id: this.connectorId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else if (!isHidden && this.state === ConnectorState.PAUSED) {
        this.resume().catch((err) => {
          logger.warning('inpage_resume_failed', {
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
          logger.info('inpage_page_lifecycle', {
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
      logger.debug('inpage_initial_visibility', {
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

  /**
   * Override start() to check initial visibility state
   */
  async start(inboundHandler: FameEnvelopeHandler): Promise<void> {
    await super.start(inboundHandler);
    
    // After transitioning to STARTED, check if tab is already hidden
    if (typeof document !== 'undefined' && document.hidden) {
      logger.debug('inpage_start_in_hidden_tab', {
        channel: this.channelName,
        connector_id: this.connectorId,
        document_hidden: document.hidden,
        visibility_state: document.visibilityState,
        has_focus: document.hasFocus(),
        timestamp: new Date().toISOString(),
      });
      
      // Immediately pause if tab is hidden at start time
      await this.pause().catch((err) => {
        logger.warning('inpage_initial_pause_failed', {
          channel: this.channelName,
          connector_id: this.connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // Allow listeners to feed envelopes directly into the in-page receive queue.
  async pushToReceive(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): Promise<void> {
    const item = this._normalizeInboxItem(rawOrEnvelope);

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
        logger.warning('inpage_push_queue_full', {
          channel: this.channelName,
        });
        throw error;
      }

      logger.error('inpage_push_failed', {
        channel: this.channelName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  protected async _transportSendBytes(data: Uint8Array): Promise<void> {
    ensureBrowserEnvironment();
    logger.debug('inpage_message_sending', {
      channel: this.channelName,
      sender_id: this.connectorId,
    });
    const event = new MessageEvent(this.channelName, {
      data: {
        senderId: this.connectorId,
        payload: data,
      },
    });
    getSharedBus().dispatchEvent(event);
  }

  protected async _transportReceive(): Promise<InPageInboxItem> {
    return await this.inbox.dequeue();
  }

  protected async _transportClose(code: number, reason: string): Promise<void> {
    if (this.listenerRegistered) {
      getSharedBus().removeEventListener(
        this.channelName,
        this.onMsg as EventListener
      );
      this.listenerRegistered = false;
    }

    if (this.visibilityChangeListenerRegistered && this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeListenerRegistered = false;
      this.visibilityChangeHandler = undefined;
    }

    const closeCode = typeof code === 'number' ? code : 1000;
    const closeReason = typeof reason === 'string' && reason.length > 0 ? reason : 'closed';
    const shutdownError = new FameTransportClose(closeReason, closeCode);
    this.inbox.drain(shutdownError);
  }

  private _normalizeInboxItem(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): InPageInboxItem {
    if (rawOrEnvelope instanceof Uint8Array) {
      return rawOrEnvelope;
    }

    return rawOrEnvelope;
  }
}
