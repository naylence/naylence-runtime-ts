import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import type { TransportListenerConfig } from '../transport-listener-config.js';
import type { TransportListener } from '../transport-listener.js';

const mockListener = {
  priority: 1000,
  onNodeStarted: jest.fn(),
  onNodeStopped: jest.fn(),
  getCallbackGrant: () => null,
  asCallbackGrant: () => null,
} as unknown as TransportListener;

describe('TransportListenerFactory', () => {
  let TransportListenerFactory: typeof import('../transport-listener-factory.js').TransportListenerFactory;
  let createTransportListenerSpy: jest.SpiedFunction<
    typeof TransportListenerFactory.createTransportListener
  >;

  beforeAll(async () => {
    const module = await import('../transport-listener-factory.js');
    TransportListenerFactory = module.TransportListenerFactory;
  });

  describe('createTransportListeners', () => {
    beforeEach(() => {
      // Mock the single-listener creation method
      createTransportListenerSpy = jest
        .spyOn(TransportListenerFactory, 'createTransportListener')
        .mockResolvedValue(mockListener as TransportListener);
    });

    afterEach(() => {
      createTransportListenerSpy.mockRestore();
    });

    it('creates listeners for configs without enabled property', async () => {
      const configs: TransportListenerConfig[] = [
        { type: 'HttpListener', port: 8080 },
        { type: 'WebSocketListener', port: 8080 },
      ];

      const listeners = await TransportListenerFactory.createTransportListeners(
        configs,
        []
      );

      expect(listeners).toHaveLength(2);
      expect(createTransportListenerSpy).toHaveBeenCalledTimes(2);
    });

    it('creates listeners when enabled is explicitly true', async () => {
      const configs: TransportListenerConfig[] = [
        { type: 'HttpListener', port: 8080, enabled: true },
        { type: 'WebSocketListener', port: 8080, enabled: true },
      ];

      const listeners = await TransportListenerFactory.createTransportListeners(
        configs,
        []
      );

      expect(listeners).toHaveLength(2);
      expect(createTransportListenerSpy).toHaveBeenCalledTimes(2);
    });

    it('skips listeners when enabled is false', async () => {
      const configs: TransportListenerConfig[] = [
        { type: 'HttpListener', port: 8080, enabled: true },
        { type: 'WebSocketListener', port: 8080, enabled: false },
        { type: 'AgentHttpGatewayListener', port: 8080, enabled: false },
      ];

      const listeners = await TransportListenerFactory.createTransportListeners(
        configs,
        []
      );

      expect(listeners).toHaveLength(1);
      expect(createTransportListenerSpy).toHaveBeenCalledTimes(1);
    });

    it('skips all listeners when all are disabled', async () => {
      const configs: TransportListenerConfig[] = [
        { type: 'HttpListener', port: 8080, enabled: false },
        { type: 'WebSocketListener', port: 8080, enabled: false },
      ];

      const listeners = await TransportListenerFactory.createTransportListeners(
        configs,
        []
      );

      expect(listeners).toHaveLength(0);
      expect(createTransportListenerSpy).not.toHaveBeenCalled();
    });

    it('handles mixed enabled/disabled/unspecified configs', async () => {
      const configs: TransportListenerConfig[] = [
        { type: 'HttpListener', port: 8080 }, // no enabled property (defaults to enabled)
        { type: 'WebSocketListener', port: 8080, enabled: true },
        { type: 'AgentHttpGatewayListener', port: 8080, enabled: false },
      ];

      const listeners = await TransportListenerFactory.createTransportListeners(
        configs,
        []
      );

      expect(listeners).toHaveLength(2);
      expect(createTransportListenerSpy).toHaveBeenCalledTimes(2);
    });

    it('handles Record<string, unknown> configs with enabled: false', async () => {
      const configs: Array<Record<string, unknown>> = [
        { type: 'HttpListener', port: 8080 },
        { type: 'WebSocketListener', port: 8080, enabled: false },
      ];

      const listeners = await TransportListenerFactory.createTransportListeners(
        configs,
        []
      );

      expect(listeners).toHaveLength(1);
      expect(createTransportListenerSpy).toHaveBeenCalledTimes(1);
    });
  });
});
