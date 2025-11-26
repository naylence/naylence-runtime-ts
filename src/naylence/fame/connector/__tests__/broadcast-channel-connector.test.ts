import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  BroadcastChannelConnector,
  BROADCAST_CHANNEL_CONNECTOR_TYPE,
} from '../broadcast-channel-connector.browser.js';
import type { FameEnvelope } from '@naylence/core';

class FakeBroadcastChannel {
  private static registry = new Map<string, Set<(event: MessageEvent<unknown>) => void>>();
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(private readonly name: string) {}

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    if (type !== 'message') {
      return;
    }

    const handler = typeof listener === 'function' ? listener : listener.handleEvent;
    if (typeof handler !== 'function') {
      return;
    }

    const wrapped = handler as (event: MessageEvent<unknown>) => void;
    this.listeners.add(wrapped);
    const channelListeners =
      FakeBroadcastChannel.registry.get(this.name) ?? new Set<(event: MessageEvent<unknown>) => void>();
    channelListeners.add(wrapped);
    FakeBroadcastChannel.registry.set(this.name, channelListeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    if (type !== 'message') {
      return;
    }

    const handler = typeof listener === 'function' ? listener : listener.handleEvent;
    if (typeof handler !== 'function') {
      return;
    }

    const wrapped = handler as (event: MessageEvent<unknown>) => void;
    this.listeners.delete(wrapped);
    const channelListeners = FakeBroadcastChannel.registry.get(this.name);
    channelListeners?.delete(wrapped);
    if (channelListeners && channelListeners.size === 0) {
      FakeBroadcastChannel.registry.delete(this.name);
    }
  }

  postMessage(message: unknown): void {
    const channelListeners = FakeBroadcastChannel.registry.get(this.name);
    if (!channelListeners) {
      return;
    }
    for (const listener of Array.from(channelListeners)) {
      listener({ data: message } as MessageEvent<unknown>);
    }
  }

  close(): void {
    for (const listener of Array.from(this.listeners)) {
      this.removeEventListener('message', listener as EventListener);
    }
  }

  static reset(): void {
    this.registry.clear();
  }
}

describe('BroadcastChannelConnector', () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined;
  let originalWindow: unknown;

  beforeEach(() => {
    originalBroadcastChannel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = globalThis;
    (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    FakeBroadcastChannel.reset();
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBroadcastChannel;
    FakeBroadcastChannel.reset();
  });

  it('allows duplicate delivery acknowledgements from other senders', async () => {
    const connector = new BroadcastChannelConnector({
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
      channelName: 'dup-test',
    });

    const received: FameEnvelope[] = [];
    await connector.start(async (envelope) => {
      received.push(envelope);
      return null;
    });

    const remote = new FakeBroadcastChannel('dup-test');
    const ackEnvelope = {
      id: 'ack-envelope',
      frame: {
        type: 'DeliveryAck',
        ok: true,
        refId: 'original-envelope',
      },
      corrId: 'original-envelope',
    };

    const payload = new TextEncoder().encode(JSON.stringify(ackEnvelope));

    remote.postMessage({ senderId: 'remote-sender', payload });
    await new Promise((resolve) => setTimeout(resolve, 0));

    remote.postMessage({ senderId: 'remote-sender', payload });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(2);

    await connector.stop();
    remote.close();
  });

  it('suppresses duplicate delivery acknowledgements pushed internally', async () => {
    const connector = new BroadcastChannelConnector({
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
      channelName: 'internal-dup-test',
    });

    const received: FameEnvelope[] = [];
    await connector.start(async (envelope) => {
      received.push(envelope);
      return null;
    });

    const payload = new TextEncoder().encode(
      JSON.stringify({
        id: 'ack-envelope',
        frame: {
          type: 'DeliveryAck',
          ok: true,
          refId: 'original-envelope',
        },
        corrId: 'original-envelope',
      })
    );

    await connector.pushToReceive(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await connector.pushToReceive(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);

    await connector.stop();
  });
});
