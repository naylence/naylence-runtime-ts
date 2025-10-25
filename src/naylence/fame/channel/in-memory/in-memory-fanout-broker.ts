/**
 * in-memory-fanout-broker.ts - In-memory fanout broker implementation
 *
 * TypeScript port of Python's InMemoryFanoutBroker that extends TaskSpawner
 * to manage multiple WriteChannel subscribers with concurrent message distribution.
 */

import {
  ReadWriteChannel,
  WriteChannel,
  DEFAULT_POLLING_TIMEOUT_MS,
  extractEnvelopeAndContext,
  createChannelMessage,
} from '@naylence/core';
import { TaskSpawner } from '../../util/task-spawner.js';
import { withEnvelopeContextAsync } from '../../util/envelope-context.js';
import { getLogger } from '../../util/logging.js';

const logger = getLogger(
  'naylence.fame.channel.in_memory.in_memory_fanout_broker'
);

// Sentinel object for shutdown signaling
const SENTINEL = Symbol('fanout-broker-sentinel');

/**
 * Interface for closeable resources
 */
interface Closeable {
  close(): Promise<void>;
}

function isCloseable(obj: any): obj is Closeable {
  return obj && typeof obj.close === 'function';
}

/**
 * Fanout broker configuration
 */
export interface InMemoryFanoutBrokerConfig {
  /** Polling timeout in milliseconds */
  pollTimeoutMs?: number;
}

/**
 * In-memory fanout broker that receives messages from a sink channel and
 * distributes them to multiple subscriber channels.
 *
 * This is the TypeScript equivalent of Python's InMemoryFanoutBroker.
 */
export class InMemoryFanoutBroker extends TaskSpawner {
  private readonly _sink: ReadWriteChannel;
  private readonly _subscribers = new Set<WriteChannel>();
  private readonly _pollTimeoutSec: number;
  private _running = false;

  constructor(sink: ReadWriteChannel, config: InMemoryFanoutBrokerConfig = {}) {
    super();
    this._sink = sink;
    this._pollTimeoutSec =
      (config.pollTimeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS) / 1000.0;
  }

  /**
   * Start the broker's listen loop
   */
  async start(): Promise<void> {
    if (this._running) {
      return;
    }

    this._running = true;
    this.spawn(async () => await this._listenLoop(), {
      name: 'fanout-broker-listen-loop',
    });
  }

  /**
   * Stop the broker and clean up resources
   */
  async stop(): Promise<void> {
    // 1) Prevent new iterations
    this._running = false;

    // Send sentinel to wake up any blocked receive
    try {
      await this._sink.send(SENTINEL as any);
    } catch (error) {
      // Ignore errors when sending sentinel (sink might be closed)
      logger.debug('error_sending_sentinel', {
        error: (error as Error).message,
      });
    }

    // 2) Shutdown spawned tasks with grace period
    await this.shutdownTasks({ gracePeriod: 3000 });

    // 3) Clean up subscribers
    const subscribersToClose = Array.from(this._subscribers);
    for (const sub of subscribersToClose) {
      if (isCloseable(sub)) {
        try {
          await sub.close();
        } catch (error) {
          logger.error('error_closing_subscriber', {
            subscriber: sub.toString(),
            error: (error as Error).message,
          });
        }
      }
    }

    this._subscribers.clear();
  }

  /**
   * Main listen loop that receives messages and distributes them to subscribers
   */
  private async _listenLoop(): Promise<void> {
    while (this._running) {
      try {
        // Non-blocking receive with timeout
        let msg: any;
        try {
          // Convert timeout from seconds to milliseconds for TypeScript timeout
          const timeoutMs = this._pollTimeoutSec * 1000;
          msg = await this._sink.receive(timeoutMs);
        } catch (error) {
          // Timeout or other receive error - continue loop
          continue;
        }

        if (msg === null || msg === undefined) {
          continue;
        }

        // Check for sentinel (shutdown signal)
        if (msg === SENTINEL) {
          this._running = false;
          break;
        }

        // Extract envelope from channel message or use direct envelope
        let envelope, context;
        try {
          [envelope, context] = extractEnvelopeAndContext(msg);
        } catch (error) {
          logger.debug('failed_to_extract_envelope', {
            error: (error as Error).message,
          });
          continue;
        }

        if (!envelope) {
          continue;
        }

        // Deliver to each subscriber individually
        // Send the original message (with context preserved) if it's a FameChannelMessage,
        // otherwise send the envelope directly
        const messageToSend =
          context !== undefined
            ? createChannelMessage(envelope, context)
            : envelope;

        const badSubs: WriteChannel[] = [];
        const subscribersSnapshot = Array.from(this._subscribers);

        for (const sub of subscribersSnapshot) {
          await withEnvelopeContextAsync(envelope, async () => {
            try {
              await sub.send(messageToSend);
            } catch (error) {
              logger.error('error_sending_to_subscriber', {
                subscriber: sub.toString(),
                error: (error as Error).message,
                action: 'unsubscribing',
              });
              badSubs.push(sub);
            }
          });
        }

        // Remove any subscribers that failed
        for (const sub of badSubs) {
          this._subscribers.delete(sub);
        }
      } catch (error) {
        // Critical broker-level error: log and back off, but keep the loop running
        logger.critical('receive_loop_failed_unexpectedly', {
          error: (error as Error).message,
          stack: (error as Error).stack,
        });

        // Back off for 500ms before retrying
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /**
   * Add a subscriber channel
   */
  addSubscriber(channel: WriteChannel): void {
    this._subscribers.add(channel);
  }

  /**
   * Remove a subscriber channel
   */
  removeSubscriber(channel: WriteChannel): void {
    this._subscribers.delete(channel);
  }

  /**
   * Get the current number of subscribers
   */
  get subscriberCount(): number {
    return this._subscribers.size;
  }

  /**
   * Check if the broker is running
   */
  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Get a copy of the current subscribers
   */
  get subscribers(): ReadonlySet<WriteChannel> {
    return new Set(this._subscribers);
  }
}
