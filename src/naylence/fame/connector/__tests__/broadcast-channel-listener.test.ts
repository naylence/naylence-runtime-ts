import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { BroadcastChannelListener } from '../broadcast-channel-listener.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';

class FakeBroadcastChannel {
  constructor(public readonly name: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  close(): void {}
}

class FakeMessageEvent<T = unknown> {
  constructor(public readonly data: T) {}
}

describe('BroadcastChannelListener', () => {
  let originalWindow: any;
  let originalBroadcastChannel: any;
  let originalMessageEvent: any;

  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window;
    originalBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    originalMessageEvent = (globalThis as { MessageEvent?: unknown }).MessageEvent;

    (globalThis as { window?: unknown }).window = globalThis;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
    (globalThis as { MessageEvent?: unknown }).MessageEvent = FakeMessageEvent as unknown as typeof MessageEvent;
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = originalBroadcastChannel;
    (globalThis as { MessageEvent?: unknown }).MessageEvent = originalMessageEvent;
  });

  it('derives the local node id exclusively from the routing node id', () => {
    const listener = new BroadcastChannelListener({ channelName: 'test' });
    (listener as unknown as { _routingNode?: RoutingNodeLike })._routingNode = {
      id: 'sentinel-node-id',
      sid: 'SENTINEL_SID',
    } as RoutingNodeLike;

    const localNodeId = (listener as unknown as {
      _requireLocalNodeId: () => string;
    })._requireLocalNodeId();

    expect(localNodeId).toBe('sentinel-node-id');
  });
});
