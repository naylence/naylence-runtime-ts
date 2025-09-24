/**
 * in-memory-channel.ts - In-memory ReadWriteChannel implementation
 * 
 * TypeScript port of Python's InMemoryReadWriteChannel that uses an internal
 * queue for message storage and provides async read/write operations with
 * timeout support.
 */

import { ReadWriteChannel } from 'naylence-core';
import { TaskTimeoutError } from '../../util/task-types.js';

export interface InMemoryChannelConfig {
  /** Maximum queue size (0 = unlimited) */
  maxsize?: number;
  /** Default timeout for operations in milliseconds */
  defaultTimeoutMs?: number;
}

interface WaitingReader {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
}

/**
 * In-memory implementation of ReadWriteChannel using a Promise-based queue.
 * This is the TypeScript equivalent of Python's asyncio.Queue-based implementation.
 */
export class InMemoryReadWriteChannel implements ReadWriteChannel {
  private readonly _queue: any[] = [];
  private readonly _waitingReaders: WaitingReader[] = [];
  private readonly _maxsize: number;
  private readonly _defaultTimeoutMs: number;
  private _closed = false;

  constructor(config: InMemoryChannelConfig = {}) {
    this._maxsize = config.maxsize || 0; // 0 = unlimited
    this._defaultTimeoutMs = config.defaultTimeoutMs || 0; // 0 = no timeout
  }

  /**
   * Receive a message from the channel.
   * Returns a promise that resolves when a message is available.
   * This implements the ReadChannel.receive method.
   */
  async receive(timeout?: number): Promise<any> {
    if (this._closed) {
      throw new Error('Channel is closed');
    }

    // If there's a message in the queue, return it immediately
    if (this._queue.length > 0) {
      const message = this._queue.shift()!;
      return message;
    }

    // No message available, wait for one
    return new Promise<any>((resolve, reject) => {
      const waiter: WaitingReader = { resolve, reject };
      
      // Set up timeout if specified
      const timeoutMs = timeout ?? this._defaultTimeoutMs;
      if (timeoutMs > 0) {
        waiter.timeoutId = setTimeout(() => {
          // Remove this waiter from the list
          const index = this._waitingReaders.indexOf(waiter);
          if (index !== -1) {
            this._waitingReaders.splice(index, 1);
          }
          reject(new TaskTimeoutError('Channel receive operation', timeoutMs));
        }, timeoutMs);
      }

      this._waitingReaders.push(waiter);
    });
  }

  /**
   * Acknowledge a received message by its ID.
   * This implements the ReadChannel.acknowledge method.
   * For in-memory channels, this is typically a no-op.
   */
  async acknowledge(_messageId: string): Promise<void> {
    // In-memory channels don't need acknowledgment tracking
    // This is a no-op but satisfies the interface requirement
    if (this._closed) {
      throw new Error('Channel is closed');
    }
    // No-op - acknowledgment is not meaningful for in-memory channels
  }

  /**
   * Send a message to the channel.
   * If there are waiting readers, delivers directly to the first one.
   * Otherwise, adds to the queue (if there's space).
   * This implements the WriteChannel.send method.
   */
  async send(message: any): Promise<void> {
    if (this._closed) {
      throw new Error('Channel is closed');
    }

    // If there are waiting readers, deliver directly to the first one
    if (this._waitingReaders.length > 0) {
      const waiter = this._waitingReaders.shift()!;
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
      waiter.resolve(message);
      return;
    }

    // No waiting readers, add to queue if there's space
    if (this._maxsize === 0 || this._queue.length < this._maxsize) {
      this._queue.push(message);
      return;
    }

    // Queue is full - in Python implementation, this would block
    // For simplicity in this TypeScript version, we'll reject immediately
    // In a full implementation, we'd want to wait for space to become available
    throw new Error(`Channel queue is full (maxsize: ${this._maxsize})`);
  }

  /**
   * Close the channel. All pending reads will be rejected.
   * Future read/write operations will throw an error.
   */
  async close(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;

    // Reject all waiting readers
    const error = new Error('Channel is closed');
    for (const waiter of this._waitingReaders) {
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
      waiter.reject(error);
    }
    this._waitingReaders.length = 0;

    // Clear the queue
    this._queue.length = 0;
  }

  /**
   * Check if the channel is closed
   */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Get the current queue size
   */
  get queueSize(): number {
    return this._queue.length;
  }

  /**
   * Get the number of waiting readers
   */
  get waitingReaders(): number {
    return this._waitingReaders.length;
  }

  /**
   * Check if the queue is full
   */
  get isFull(): boolean {
    return this._maxsize > 0 && this._queue.length >= this._maxsize;
  }

  /**
   * Check if the queue is empty
   */
  get isEmpty(): boolean {
    return this._queue.length === 0;
  }
}