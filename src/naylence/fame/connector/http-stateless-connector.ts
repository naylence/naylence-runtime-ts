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
import type { FameEnvelope, FameChannelMessage } from '@naylence/core';

export { QueueFullError } from '../util/bounded-async-queue.js';

const logger = getLogger('naylence.fame.connector.http_stateless_connector');

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type QueueItem = Uint8Array | FameEnvelope | FameChannelMessage;

export interface HttpStatelessConnectorConfig
  extends BaseAsyncConnectorConfig,
    ConnectorConfig {
  type: 'HttpStatelessConnector';
  url: string;
  maxQueue?: number;
}

export interface HttpStatelessConnectorDependencies {
  fetchImplementation?: FetchImplementation;
}

export class HttpStatelessConnector extends BaseAsyncConnector {
  private readonly url: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly receiveQueue: BoundedAsyncQueue<QueueItem>;
  private authHeader: string | null = null;
  private shuttingDown = false;

  constructor(
    config: HttpStatelessConnectorConfig,
    dependencies: HttpStatelessConnectorDependencies = {}
  ) {
    super(config);

    this.url = config.url;

    const legacyMaxQueue = (config as { max_queue?: unknown }).max_queue;
    const preferredQueueValue =
      config.maxQueue ??
      (legacyMaxQueue !== undefined ? legacyMaxQueue : undefined);
    const parsedQueueValue =
      typeof preferredQueueValue === 'number'
        ? preferredQueueValue
        : preferredQueueValue !== undefined
          ? Number(preferredQueueValue)
          : undefined;
    const queueSize =
      parsedQueueValue !== undefined &&
      Number.isFinite(parsedQueueValue) &&
      parsedQueueValue > 0
        ? parsedQueueValue
        : 1024;

    this.receiveQueue = new BoundedAsyncQueue<QueueItem>(queueSize);

    const candidateFetch =
      dependencies.fetchImplementation ??
      (globalThis as { fetch?: FetchImplementation }).fetch?.bind(globalThis) ??
      null;

    if (typeof candidateFetch !== 'function') {
      throw new Error('Fetch API is required for HttpStatelessConnector');
    }

    this.fetchImpl = candidateFetch as FetchImplementation;
  }

  public setAuthHeader(header: string): void {
    if (typeof header === 'string' && header.trim().length > 0) {
      this.authHeader = header.trim();
    }
  }

  public get remainingQueueCapacity(): number {
    return this.receiveQueue.remainingCapacity;
  }

  async pushToReceive(
    rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    try {
      this.receiveQueue.enqueue(rawOrEnvelope);
    } catch (error) {
      if (error instanceof QueueFullError) {
        logger.warning('receive_queue_full', {
          url: this.url,
        });
      }
      throw error;
    }
  }

  protected async _transportSendBytes(data: Uint8Array): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        body: data as unknown as BodyInit,
        headers,
      });

      if (!response.ok) {
        const statusText = response.statusText || 'HTTP error';
        logger.error('http_request_failed', {
          url: this.url,
          status: response.status,
          statusText,
        });
        throw new FameTransportClose(
          `${response.status} ${statusText}`,
          response.status
        );
      }
    } catch (error) {
      if (error instanceof FameTransportClose) {
        throw error;
      }

      logger.error('http_request_error', {
        url: this.url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new FameTransportClose(
        `HTTP request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        1006
      );
    }
  }

  protected async _transportReceive(): Promise<QueueItem> {
    try {
      return await this.receiveQueue.dequeue();
    } catch (error) {
      if (error instanceof FameTransportClose) {
        throw error;
      }

      if (error instanceof Error && error.name === 'QueueFullError') {
        throw new FameTransportClose(error.message, 1013);
      }

      if (error instanceof Error && error.message === 'Queue closed') {
        throw new FameTransportClose('Connector shutdown requested', 1000);
      }

      if (error instanceof Error) {
        throw error;
      }

      throw new Error(String(error));
    }
  }

  protected async _transportClose(code: number, reason: string): Promise<void> {
    this.shuttingDown = true;
    const shutdownError = new FameTransportClose(reason, code);
    this.receiveQueue.drain(shutdownError);
  }
}
