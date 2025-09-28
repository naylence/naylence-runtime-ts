import {
  DeliveryOriginType,
  FameResponseType,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
} from 'naylence-core';

import { NodeHeartbeatFrameHandler } from '../node-heartbeat-frame-handler.js';

describe('NodeHeartbeatFrameHandler', () => {
  function createRoutingNode(options: {
    routingEpoch?: string | null;
    onForwardResult?: FameEnvelope | null;
    onForwardComplete?: () => void;
    onForwardCompleteReject?: boolean;
    onForwardCompleteErrorReject?: boolean;
  } = {}) {
    const processedEnvelope: FameEnvelope | null | undefined =
      options.onForwardResult === undefined ? ({ id: 'processed-env', frame: { type: 'NodeHeartbeatAck' } } as FameEnvelope) : options.onForwardResult;

    const dispatchEnvelopeEvent = jest.fn(async (event: string, ...args: unknown[]) => {
      if (event === 'onForwardToRoute') {
        return processedEnvelope ?? null;
      }

      if (event === 'onForwardToRouteComplete') {
        const errorArg = args[4];
        if (!errorArg && options.onForwardCompleteReject) {
          throw new Error('complete listener failure');
        }

        if (errorArg instanceof Error && options.onForwardCompleteErrorReject) {
          throw new Error('cleanup failure');
        }

        options.onForwardComplete?.();
        return args[2] as FameEnvelope;
      }

      return null;
    });

    const createEnvelope = jest.fn((_options: unknown) => ({
      id: 'ack-env',
      frame: { type: 'NodeHeartbeatAck' },
      corrId: 'ack-corr',
    })) as jest.MockedFunction<any>;

    return {
      routingEpoch: options.routingEpoch,
      dispatchEnvelopeEvent,
      envelopeFactory: { createEnvelope },
    };
  }

  function createConnector(sendImplementation?: () => Promise<void>) {
    return {
      send: jest.fn(sendImplementation ?? (async () => {})),
    } as unknown as jest.Mocked<FameConnector>;
  }

  function createContext(connector?: FameConnector): FameDeliveryContext {
    return {
      fromConnector: connector,
      originType: DeliveryOriginType.UPSTREAM,
      expectedResponseType: FameResponseType.NONE,
    } as unknown as FameDeliveryContext;
  }

  function createHeartbeatEnvelope(overrides: Partial<FameEnvelope> = {}, frameOverrides: Record<string, unknown> = {}) {
    const frame = {
      type: 'NodeHeartbeat',
      systemId: 'system-1',
      address: 'route://child',
      ...frameOverrides,
    } as Record<string, unknown>;

    return {
      id: 'heartbeat-env',
      corrId: 'corr-1',
      traceId: 'trace-1',
      frame,
      ...overrides,
    } as FameEnvelope;
  }

  it('acknowledges heartbeat and forwards envelope', async () => {
    const routingNode = createRoutingNode({ routingEpoch: 'epoch-123' });
    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });

    const connector = createConnector();
    const context = createContext(connector);

    const heartbeatEnvelope = createHeartbeatEnvelope();

    await handler.acceptNodeHeartbeat(heartbeatEnvelope, context);

    expect(routingNode.envelopeFactory.createEnvelope).toHaveBeenCalledWith({
      frame: expect.objectContaining({
        type: 'NodeHeartbeatAck',
        ok: true,
        refId: 'heartbeat-env',
        routingEpoch: 'epoch-123',
        address: 'route://child',
      }),
      corrId: 'corr-1',
      traceId: 'trace-1',
    });

    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenNthCalledWith(
      1,
      'onForwardToRoute',
      routingNode,
      'system-1',
      expect.objectContaining({ frame: expect.objectContaining({ type: 'NodeHeartbeatAck' }) }),
      context
    );

    expect(connector.send).toHaveBeenCalledWith(expect.objectContaining({ frame: { type: 'NodeHeartbeatAck' } }));
    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenCalledWith(
      'onForwardToRouteComplete',
      routingNode,
      'system-1',
      expect.any(Object),
      undefined,
      undefined,
      context
    );
  });

  it('omits optional ack fields when metadata is absent', async () => {
    const routingNode = createRoutingNode({ routingEpoch: null });
    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });

    const connector = createConnector();
    const context = createContext(connector);

    const envelope = createHeartbeatEnvelope({}, { address: undefined });
    delete (envelope as any).id;
    delete (envelope as any).corrId;
    delete (envelope as any).traceId;

    await handler.acceptNodeHeartbeat(envelope, context);

    const callArgs = routingNode.envelopeFactory.createEnvelope.mock.calls[0][0] as Record<string, unknown>;
    const ackFrame = callArgs.frame as Record<string, unknown>;

    expect(ackFrame).toMatchObject({ type: 'NodeHeartbeatAck', ok: true });
    expect(ackFrame).not.toHaveProperty('refId');
    expect(ackFrame).not.toHaveProperty('routingEpoch');
    expect(ackFrame).not.toHaveProperty('address');
    expect(callArgs).not.toHaveProperty('corrId');
    expect(callArgs).not.toHaveProperty('traceId');
  });

  it('throws when envelope frame is missing or invalid', async () => {
    const handler = new NodeHeartbeatFrameHandler({
      routingNode: createRoutingNode() as any,
    });

  const envelope = { frame: { type: 'OtherFrame' } } as unknown as FameEnvelope;

    await expect(handler.acceptNodeHeartbeat(envelope, createContext(createConnector()))).rejects.toThrow(
      'Invalid envelope frame. Expected: NodeHeartbeatFrame, actual: OtherFrame'
    );
  });

  it('throws when envelope frame is entirely missing', async () => {
    const handler = new NodeHeartbeatFrameHandler({ routingNode: createRoutingNode() as any });
    const envelope = { frame: undefined } as unknown as FameEnvelope;

    await expect(handler.acceptNodeHeartbeat(envelope, createContext(createConnector()))).rejects.toThrow(
      'Invalid envelope frame. Expected: NodeHeartbeatFrame, actual: unknown'
    );
  });

  it('throws when delivery context is missing', async () => {
    const handler = new NodeHeartbeatFrameHandler({ routingNode: createRoutingNode() as any });
    const heartbeatEnvelope = createHeartbeatEnvelope();

    await expect(handler.acceptNodeHeartbeat(heartbeatEnvelope, undefined)).rejects.toThrow(
      'missing FameDeliveryContext'
    );
  });

  it('throws when connector is not present in context', async () => {
    const handler = new NodeHeartbeatFrameHandler({ routingNode: createRoutingNode() as any });
    const heartbeatEnvelope = createHeartbeatEnvelope();

    const context = createContext(undefined);

    await expect(handler.acceptNodeHeartbeat(heartbeatEnvelope, context)).rejects.toThrow(
      'Connector in context does not match pending connector'
    );
  });

  it('throws when forwarding event blocks the envelope', async () => {
    const routingNode = createRoutingNode({ onForwardResult: null });
    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });

    const connector = createConnector();
    const context = createContext(connector);

    await expect(handler.acceptNodeHeartbeat(createHeartbeatEnvelope(), context)).rejects.toThrow(
      'Envelope was blocked by onForwardToRoute event'
    );

    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenNthCalledWith(
      2,
      'onForwardToRouteComplete',
      routingNode,
      'system-1',
      expect.any(Object),
      undefined,
      expect.any(Error),
      context
    );
  });

  it('propagates errors from connector.send and notifies completion with error', async () => {
    const routingNode = createRoutingNode();
    const error = new Error('send failed');
    const connector = createConnector(async () => {
      throw error;
    });

    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });
    const context = createContext(connector);

    await expect(handler.acceptNodeHeartbeat(createHeartbeatEnvelope(), context)).rejects.toThrow('send failed');

    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenNthCalledWith(
      2,
      'onForwardToRouteComplete',
      routingNode,
      'system-1',
      expect.any(Object),
      undefined,
      error,
      context
    );
  });

  it('ignores errors thrown by onForwardToRouteComplete after successful send', async () => {
    const routingNode = createRoutingNode({ onForwardCompleteReject: true });
    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });

    const connector = createConnector();
    const context = createContext(connector);

    await expect(handler.acceptNodeHeartbeat(createHeartbeatEnvelope(), context)).resolves.toBeUndefined();

    expect(connector.send).toHaveBeenCalledTimes(1);
    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenCalledWith(
      'onForwardToRouteComplete',
      routingNode,
      'system-1',
      expect.any(Object),
      undefined,
      undefined,
      context
    );
  });

  it('still throws the original error when cleanup listener rejects during failure handling', async () => {
    const routingNode = createRoutingNode({ onForwardCompleteErrorReject: true });
    const error = new Error('send failed');
    const connector = createConnector(async () => {
      throw error;
    });

    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });
    const context = createContext(connector);

    await expect(handler.acceptNodeHeartbeat(createHeartbeatEnvelope(), context)).rejects.toThrow('send failed');

    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenNthCalledWith(
      2,
      'onForwardToRouteComplete',
      routingNode,
      'system-1',
      expect.any(Object),
      undefined,
      error,
      context
    );
  });

  it('uses fallback identifiers when ack envelope metadata is absent', async () => {
    const routingNode = createRoutingNode();
    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });

    routingNode.envelopeFactory.createEnvelope.mockImplementation((options: any) => {
      return {
        frame: options.frame,
      } as FameEnvelope;
    });

    const connector = createConnector();
    const context = createContext(connector);

    const envelope = createHeartbeatEnvelope({}, { systemId: undefined, address: undefined });

    await handler.acceptNodeHeartbeat(envelope, context);

    expect(routingNode.dispatchEnvelopeEvent).toHaveBeenNthCalledWith(
      1,
      'onForwardToRoute',
      routingNode,
      'unknown',
      expect.any(Object),
      context
    );

  const envelopeArg = routingNode.dispatchEnvelopeEvent.mock.calls[0]?.[3] as FameEnvelope;
  expect(envelopeArg.frame).toMatchObject({ type: 'NodeHeartbeatAck' });
  });

  it('coerces non-error failures thrown by connector.send', async () => {
    const routingNode = createRoutingNode({ onForwardCompleteErrorReject: true });
    const connector = createConnector(async () => {
      throw 'string-failure';
    });

    const handler = new NodeHeartbeatFrameHandler({ routingNode: routingNode as any });
    const context = createContext(connector);

    await expect(handler.acceptNodeHeartbeat(createHeartbeatEnvelope(), context)).rejects.toThrow(
      'string-failure'
    );
  });
});
