/**
 * in-memory-binding.ts - In-memory binding implementation
 *
 * TypeScript port of Python's InMemoryBinding that connects a FameAddress
 * to an InMemoryReadWriteChannel, managing the binding lifecycle.
 */

import { FameAddress } from "naylence-core";
import { InMemoryReadWriteChannel, InMemoryChannelConfig } from "./in-memory-channel.js";

/**
 * Binding configuration options
 */
export interface InMemoryBindingConfig extends InMemoryChannelConfig {
  /** Optional custom channel instance to use */
  channel?: InMemoryReadWriteChannel;
}

/**
 * Represents a binding between a FameAddress and an InMemoryReadWriteChannel.
 * This is the TypeScript equivalent of Python's InMemoryBinding.
 */
export class InMemoryBinding {
  public readonly address: FameAddress;
  public readonly channel: InMemoryReadWriteChannel;

  constructor(address: FameAddress | string, config: InMemoryBindingConfig = {}) {
    // Convert string address to FameAddress if needed
    this.address = typeof address === "string" ? new FameAddress(address) : address;

    // Use provided channel or create a new one
    this.channel = config.channel || new InMemoryReadWriteChannel(config);
  }

  /**
   * Create a binding from an address string
   */
  static fromAddress(address: string, config: InMemoryBindingConfig = {}): InMemoryBinding {
    return new InMemoryBinding(address, config);
  }

  /**
   * Create a binding with a custom channel
   */
  static withChannel(
    address: FameAddress | string,
    channel: InMemoryReadWriteChannel
  ): InMemoryBinding {
    return new InMemoryBinding(address, { channel });
  }

  /**
   * Close the binding and its associated channel
   */
  async close(): Promise<void> {
    await this.channel.close();
  }

  /**
   * Check if the binding is closed
   */
  get isClosed(): boolean {
    return this.channel.isClosed;
  }

  /**
   * Get a string representation of the binding
   */
  toString(): string {
    return `InMemoryBinding(address=${this.address.toString()}, channel=${this.channel})`;
  }

  /**
   * Convert the binding to a plain object for serialization
   */
  toObject(): { address: string; channelState: { queueSize: number; isClosed: boolean } } {
    return {
      address: this.address.toString(),
      channelState: {
        queueSize: this.channel.queueSize,
        isClosed: this.channel.isClosed,
      },
    };
  }

  /**
   * Send a message through the binding's channel
   */
  async send(message: any): Promise<void> {
    return this.channel.send(message);
  }

  /**
   * Receive a message from the binding's channel
   */
  async receive(timeout?: number): Promise<any> {
    return this.channel.receive(timeout);
  }

  /**
   * Acknowledge a message through the binding's channel
   */
  async acknowledge(messageId: string): Promise<void> {
    return this.channel.acknowledge(messageId);
  }
}
