import { DeliveryOriginType, createFameEnvelope } from '@naylence/core';

import { GRANT_PURPOSE_NODE_ATTACH } from '../../grants/grant.js';
import {
  InPageListener,
  getInPageListenerInstance,
} from '../inpage-listener.js';
import { INPAGE_CONNECTION_GRANT_TYPE } from '../../grants/inpage-connection-grant.js';

describe('InPageListener', () => {
  const globals = globalThis as Record<string, unknown>;

  const originalWindow = globals.window;
  const originalDocument = globals.document;
  const originalMessageEvent = globals.MessageEvent;

  beforeAll(() => {
    globals.window = globalThis;
    globals.document = {};

    if (typeof globalThis.MessageEvent === 'undefined') {
      class PolyfillMessageEvent<T> extends Event {
        public data: T;
        constructor(type: string, init: MessageEventInit<T>) {
          super(type, init);
          this.data = init.data as T;
        }
      }

      globals.MessageEvent = PolyfillMessageEvent;
    }
  });

  beforeEach(() => {
    globals.__naylence_inpage_bus__ = new EventTarget();
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete globals.window;
    } else {
      globals.window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete globals.document;
    } else {
      globals.document = originalDocument;
    }

    if (originalMessageEvent === undefined) {
      delete globals.MessageEvent;
    } else {
      globals.MessageEvent = originalMessageEvent;
    }
  });

  it('throws when constructed outside of a browser-like environment', () => {
    const savedWindow = globals.window;
    const savedDocument = globals.document;

    delete globals.window;
    delete globals.document;

    try {
      expect(() => new InPageListener()).toThrow(
        /InPageListener is browser-only/i
      );
    } finally {
      globals.window = savedWindow;
      globals.document = savedDocument;
    }
  });

  it('provides callback grants with legacy key aliases', () => {
    const listener = new InPageListener({
      channelName: 'demo-channel',
      inboxCapacity: 512,
    });

    const grant = listener.getCallbackGrant();
    expect(grant).toMatchObject({
      type: 'InPageConnectionGrant',
      purpose: GRANT_PURPOSE_NODE_ATTACH,
      channelName: 'demo-channel',
      channel_name: 'demo-channel',
      inboxCapacity: 512,
      inbox_capacity: 512,
    });
  });

  it('advertises connector configuration for reverse callbacks', () => {
    const listener = new InPageListener({
      channelName: 'attach-channel',
      inboxCapacity: 1024,
    });

    const config = listener.asCallbackGrant();
    expect(config).toMatchObject({
      type: 'inpage-connector',
      channelName: 'attach-channel',
      inboxCapacity: 1024,
    });
    expect(config).toHaveProperty('channel_name', 'attach-channel');
    expect(config).toHaveProperty('inbox_capacity', 1024);
  });

  it('tracks running state across lifecycle events', async () => {
    const listener = new InPageListener();

    expect(listener.initialized).toBe(false);
    expect(listener.isRunning).toBe(false);

    await listener.onNodeInitialized({} as any);
    expect(listener.initialized).toBe(true);
    expect(listener.isRunning).toBe(false);

    await listener.onNodeStarted({} as any);
    expect(listener.isRunning).toBe(true);

    await listener.onNodeStopped({} as any);
    expect(listener.isRunning).toBe(false);
  });

  it('updates the last listener instance helper', () => {
    const listener = new InPageListener();
    expect(getInPageListenerInstance()).toBe(listener);
  });

  it('creates origin connectors when receiving node attach frames', async () => {
    const connector = {
      pushToReceive: jest.fn().mockResolvedValue(undefined),
      waitUntilClosed: jest.fn().mockResolvedValue(undefined),
    };

    const routingNode = {
      createOriginConnector: jest
        .fn()
        .mockImplementation(async (options: Record<string, unknown>) => {
          expect(options).toHaveProperty('connectorConfig');
          return connector;
        }),
      routeManager: {
        downstreamRoutes: new Map(),
        _pending_routes: new Map(),
      },
    } as unknown as {
      createOriginConnector: jest.Mock;
      routeManager: {
        downstreamRoutes: Map<string, unknown>;
        _pending_routes: Map<string, unknown>;
      };
    };

    const listener = new InPageListener({ channelName: 'attach-channel' });

    await listener.onNodeInitialized(routingNode as any);
    await listener.onNodeStarted(routingNode as any);

    const envelope = createFameEnvelope({
      frame: {
        type: 'NodeAttach',
        systemId: 'child-1',
        originType: DeliveryOriginType.DOWNSTREAM,
        instanceId: 'child-1-instance',
        callbackGrants: [
          {
            type: INPAGE_CONNECTION_GRANT_TYPE,
            channelName: 'child-channel',
            inboxCapacity: 256,
          },
        ],
      },
      corrId: 'corr-1',
    });

    const payload = new TextEncoder().encode(JSON.stringify(envelope));
    const bus = globals.__naylence_inpage_bus__ as EventTarget;

    bus.dispatchEvent(
      new (globals.MessageEvent as typeof MessageEvent)('attach-channel', {
        data: { senderId: 'sender-1', payload },
      })
    );

  await new Promise((resolve) => setTimeout(resolve, 0));

    expect(routingNode.createOriginConnector).toHaveBeenCalledTimes(1);
    expect(routingNode.createOriginConnector.mock.calls[0][0]).toMatchObject({
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-1',
      connectorConfig: {
        type: 'inpage-connector',
        channelName: 'child-channel',
        inboxCapacity: 256,
      },
    });

    expect(connector.pushToReceive).toHaveBeenCalledTimes(1);
    const messageArg = connector.pushToReceive.mock.calls[0][0];
    expect(messageArg.envelope.frame).toMatchObject({
      type: 'NodeAttach',
      systemId: 'child-1',
    });
    expect(messageArg.context).toMatchObject({
      originType: DeliveryOriginType.DOWNSTREAM,
      fromConnector: connector,
      fromSystemId: 'child-1',
    });
  });

  it('reuses connectors for subsequent frames from the same sender', async () => {
    const connector = {
      pushToReceive: jest.fn().mockResolvedValue(undefined),
      waitUntilClosed: jest.fn().mockResolvedValue(undefined),
    };

    const routingNode = {
      createOriginConnector: jest.fn().mockResolvedValue(connector),
      routeManager: {
        downstreamRoutes: new Map(),
        _pending_routes: new Map(),
      },
    } as unknown as {
      createOriginConnector: jest.Mock;
      routeManager: {
        downstreamRoutes: Map<string, unknown>;
        _pending_routes: Map<string, unknown>;
      };
    };

    const listener = new InPageListener({ channelName: 'attach-channel' });

    await listener.onNodeInitialized(routingNode as any);
    await listener.onNodeStarted(routingNode as any);

    const bus = globals.__naylence_inpage_bus__ as EventTarget;

    const attachEnvelope = createFameEnvelope({
      frame: {
        type: 'NodeAttach',
        systemId: 'child-1',
        originType: DeliveryOriginType.DOWNSTREAM,
        instanceId: 'child-1-instance',
        callbackGrants: [
          { type: INPAGE_CONNECTION_GRANT_TYPE, channelName: 'child-channel' },
        ],
      },
    });

    bus.dispatchEvent(
      new (globals.MessageEvent as typeof MessageEvent)('attach-channel', {
        data: {
          senderId: 'sender-1',
          payload: new TextEncoder().encode(JSON.stringify(attachEnvelope)),
        },
      })
    );

  await new Promise((resolve) => setTimeout(resolve, 0));

    const followUpEnvelope = createFameEnvelope({
      frame: { type: 'Data', payload: { note: 'follow-up' } },
    });

    bus.dispatchEvent(
      new (globals.MessageEvent as typeof MessageEvent)('attach-channel', {
        data: {
          senderId: 'sender-1',
          payload: new TextEncoder().encode(
            JSON.stringify(followUpEnvelope)
          ),
        },
      })
    );

  await new Promise((resolve) => setTimeout(resolve, 0));

    expect(routingNode.createOriginConnector).toHaveBeenCalledTimes(1);
    expect(connector.pushToReceive).toHaveBeenCalledTimes(2);
    const secondCall = connector.pushToReceive.mock.calls[1][0];
  expect(secondCall.envelope.frame).toMatchObject({ type: 'Data' });
  });

  it('ignores non-attach frames when no connector exists', async () => {
    const connector = {
      pushToReceive: jest.fn(),
      waitUntilClosed: jest.fn(),
    };

    const routingNode = {
      createOriginConnector: jest.fn().mockResolvedValue(connector),
      routeManager: {
        downstreamRoutes: new Map(),
        _pending_routes: new Map(),
      },
    } as unknown as {
      createOriginConnector: jest.Mock;
      routeManager: {
        downstreamRoutes: Map<string, unknown>;
        _pending_routes: Map<string, unknown>;
      };
    };

    const listener = new InPageListener({ channelName: 'attach-channel' });

    await listener.onNodeInitialized(routingNode as any);
    await listener.onNodeStarted(routingNode as any);

    const bus = globals.__naylence_inpage_bus__ as EventTarget;

    const envelope = createFameEnvelope({
      frame: { type: 'Data', payload: { note: 'unknown' } },
    });

    bus.dispatchEvent(
      new (globals.MessageEvent as typeof MessageEvent)('attach-channel', {
        data: {
          senderId: 'unknown',
          payload: new TextEncoder().encode(JSON.stringify(envelope)),
        },
      })
    );

  await new Promise((resolve) => setTimeout(resolve, 0));

    expect(routingNode.createOriginConnector).not.toHaveBeenCalled();
    expect(connector.pushToReceive).not.toHaveBeenCalled();
  });
});
