import { FameNode } from '../node.js';
import type { NodeEventListener } from '../node-event-listener.js';

describe('FameNode', () => {
  it('dispatches lifecycle events in priority order', async () => {
    const calls: string[] = [];

    const lowPriority: NodeEventListener = {
      priority: 100,
      async onNodeInitialized() {
        calls.push('init-low');
      },
      async onNodeStarted() {
        calls.push('start-low');
      },
    };

    const highPriority: NodeEventListener = {
      priority: 10,
      async onNodeInitialized() {
        calls.push('init-high');
      },
      async onNodeStarted() {
        calls.push('start-high');
      },
    };

    const node = new FameNode({
      systemId: 'test-node',
      physicalPath: '/test-node',
      eventListeners: [lowPriority, highPriority],
    });

    await node.start();

    expect(calls).toEqual(['init-high', 'init-low', 'start-high', 'start-low']);
    expect(node.sid).toBeDefined();

    await node.stop();
  });

  it('delivers envelopes to registered listeners', async () => {
    const node = new FameNode({
      systemId: 'deliver-node',
      physicalPath: '/deliver-node',
    });

    await node.start();

    const receivedPayloads: Array<Record<string, any>> = [];

    const address = await node.listen('service', async (envelope) => {
      if (envelope.frame.type === 'Data' && typeof envelope.frame.payload === 'object') {
        receivedPayloads.push(envelope.frame.payload as Record<string, any>);
      }
      return null;
    });

    expect(node.hasLocal(address)).toBe(true);

    const envelope = node.envelopeFactory.createEnvelope({
      to: address,
      frame: {
        type: 'Data',
        payload: { message: 'hello' },
      },
    });

    await node.deliver(envelope);

    expect(receivedPayloads).toEqual([{ message: 'hello' }]);

    await node.stop();
  });
});