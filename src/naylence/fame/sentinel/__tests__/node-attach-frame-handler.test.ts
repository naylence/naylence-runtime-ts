import {
  DeliveryOriginType,
  FameResponseType,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type NodeAttachFrame,
  type Stickiness,
} from '@naylence/core';

import { NodeAttachFrameHandler } from '../node-attach-frame-handler.js';
import { RouteManager } from '../route-manager.js';
import {
  AttachmentKeyValidator,
  KeyInfo,
  KeyValidationError,
} from '../../security/keys/attachment-key-validator.js';
import type { LoadBalancerStickinessManager } from '../../stickiness/load-balancer-stickiness-manager.js';
import type { RoutingNodeLike } from '../../node/routing-node-like.js';
import type { ConnectorConfig } from '../../connector/connector-config.js';

function createConnector(): FameConnector {
  return {
    send: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
  } as unknown as FameConnector;
}

function createRoutingNode(
  overrides: Partial<
    RoutingNodeLike & {
      routingEpoch?: string | null;
      securityManager?: { getShareableKeys(): unknown } | null;
    }
  > = {}
) {
  const envelopeFactory = {
    createEnvelope: jest.fn(
      (options: {
        frame: FameEnvelope['frame'];
        corrId?: string;
        traceId?: string;
      }) =>
        ({
          id: `ack-${Math.random().toString(16).slice(2)}`,
          frame: options.frame,
          ...(options.corrId ? { corrId: options.corrId } : {}),
          ...(options.traceId ? { traceId: options.traceId } : {}),
        }) as FameEnvelope
    ),
  };

  return {
    id: 'parent-node',
    physicalPath: '/parent',
    routingEpoch: 'epoch-1',
    envelopeFactory,
    dispatchEvent: jest.fn(async () => undefined),
    dispatchEnvelopeEvent: jest.fn(
      async (
        eventName: string,
        _node: RoutingNodeLike,
        _route: string,
        envelope: FameEnvelope
      ) => {
        if (eventName === 'onForwardToRoute') {
          return envelope;
        }
        return envelope;
      }
    ),
    deliver: jest.fn(async () => undefined),
    securityManager: {
      getShareableKeys: jest.fn(() => [{ kid: 'parent-key' }]),
    },
    ...overrides,
  } as unknown as RoutingNodeLike & {
    routingEpoch?: string | null;
    securityManager?: { getShareableKeys(): unknown } | null;
    envelopeFactory: { createEnvelope: jest.Mock };
    dispatchEvent: jest.Mock;
    dispatchEnvelopeEvent: jest.Mock;
    deliver: jest.Mock;
  };
}

function createContext(connector: FameConnector): FameDeliveryContext {
  return {
    originType: DeliveryOriginType.DOWNSTREAM,
    fromSystemId: 'child-node',
    fromConnector: connector,
    expectedResponseType: FameResponseType.NONE,
    security: undefined,
  } as FameDeliveryContext;
}

describe('NodeAttachFrameHandler', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('validates keys, registers routes, and sends acknowledgement on success', async () => {
    const connector = createConnector();
    const routingNode = createRoutingNode();
    const routeManager = new RouteManager({
      deliver: jest.fn(async () => undefined),
      getId: () => 'parent-node',
    });

    const bufferEnvelope = {
      id: 'buffer-1',
      frame: { type: 'Ping' },
    } as unknown as FameEnvelope;
    const pendingRoute = {
      connector,
      attached: { set: jest.fn(), wait: jest.fn() },
      buffer: [bufferEnvelope],
    };
    routeManager._pending_routes.set('child-node', pendingRoute);

    const connectorConfig: ConnectorConfig = {
      type: 'websocket',
      durable: true,
    };
    routeManager._pending_route_metadata.set('child-node', connectorConfig);

    const validator = {
      validateKeys: jest.fn(async () => [
        new KeyInfo({ expiresAt: Date.now() + 60_000 }),
      ]),
    } as unknown as AttachmentKeyValidator;

    const stickinessManager: LoadBalancerStickinessManager = {
      negotiate: jest.fn(() => ({ version: 1, enabled: true })),
      getStickyReplicaSegment: jest.fn(() => null),
    };

    const handler = new NodeAttachFrameHandler({
      routingNode,
      routeManager,
      attachmentKeyValidator: validator,
      stickinessManager,
      maxTtlSec: 120,
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-node',
      instanceId: 'child-instance',
      assignedPath: '/custom/path',
      keys: [{ kid: 'child-key' }],
      callbackGrants: [{ type: 'webhook' }],
    } as NodeAttachFrame;

    const envelope = {
      id: 'env-attach',
      corrId: 'corr-123',
      traceId: 'trace-456',
      frame,
    } as unknown as FameEnvelope;

    const context = createContext(connector);

    await handler.acceptNodeAttach(envelope, context);

    expect(validator.validateKeys).toHaveBeenCalledWith(frame.keys);
    expect(pendingRoute.attached.set).toHaveBeenCalledTimes(1);
    expect(pendingRoute.buffer).toHaveLength(0);

    expect(routingNode.deliver).toHaveBeenCalledWith(bufferEnvelope, {
      fromConnector: connector,
      fromSystemId: 'child-node',
      originType: DeliveryOriginType.DOWNSTREAM,
      expectedResponseType: FameResponseType.NONE,
      security: context.security,
    });

    expect(connector.send).toHaveBeenCalledTimes(1);
    const ackEnvelope = (connector.send as jest.Mock).mock
      .calls[0][0] as FameEnvelope;
    expect(ackEnvelope.frame).toMatchObject({
      type: 'NodeAttachAck',
      ok: true,
      assignedPath: '/custom/path',
      refId: 'env-attach',
      targetSystemId: routingNode.id,
      stickiness: { enabled: true, version: 1 },
    });
    expect(ackEnvelope.corrId).toBe('corr-123');

    expect(routingNode.envelopeFactory.createEnvelope).toHaveBeenCalled();

    expect(routeManager.downstreamRoutes.get('child-node')).toBe(connector);

    const storedRoutes = await routeManager._downstream_route_store.list();
    expect(storedRoutes['child-node']).toMatchObject({
      systemId: 'child-node',
      instanceId: 'child-instance',
      assignedPath: '/custom/path',
      connectorConfig,
      callbackGrants: [{ type: 'webhook' }],
    });

    expect(routeManager._pending_routes.has('child-node')).toBe(false);
    expect(routeManager._pending_route_metadata.has('child-node')).toBe(false);
  });

  it('accepts snake_case attach frames and context aliases', async () => {
    const connector = createConnector();
    const routingNode = createRoutingNode();
    const routeManager = new RouteManager({
      deliver: jest.fn(async () => undefined),
      getId: () => 'parent-node',
    });

    routeManager._pending_routes.set('child-alias', {
      connector,
      attached: { set: jest.fn(), wait: jest.fn() },
      buffer: [],
    });
    routeManager._pending_route_metadata.set('child-alias', {
      type: 'websocket',
      durable: true,
    });

    const validator = {
      validateKeys: jest.fn(async () => []),
    } as unknown as AttachmentKeyValidator;

    const stickinessManager: LoadBalancerStickinessManager = {
      negotiate: jest.fn(
        () => ({ supported_modes: ['aft'], version: 2 }) as unknown as Stickiness
      ),
      getStickyReplicaSegment: jest.fn(() => null),
    } as unknown as LoadBalancerStickinessManager;

    const handler = new NodeAttachFrameHandler({
      routingNode,
      routeManager,
      attachmentKeyValidator: validator,
      stickinessManager,
    });

    const frame = {
      type: 'node_attach',
      origin_type: 'downstream',
      system_id: 'child-alias',
      instance_id: 'child-instance',
      assigned_path: '/alias/path',
      callback_grants: [{ type: 'webhook' }],
      keys: [{ kid: 'alias-key' }],
      stickiness: { supported_modes: ['aft'], version: 1 },
    } as unknown as NodeAttachFrame;

    const envelope = {
      id: 'env-alias',
      corrId: 'corr-alias',
      frame,
    } as unknown as FameEnvelope;

    const context = {
      origin_type: 'downstream',
      from_system_id: 'child-alias',
      from_connector: connector,
      expected_response_type: FameResponseType.NONE,
    } as unknown as FameDeliveryContext;

    await handler.acceptNodeAttach(envelope, context);

    expect(context.originType).toBe(DeliveryOriginType.DOWNSTREAM);
    expect((context as any).origin_type).toBe(DeliveryOriginType.DOWNSTREAM);
    expect(context.fromConnector).toBe(connector);
    expect((context as any).from_connector).toBe(connector);
    expect(context.fromSystemId).toBe('child-alias');
    expect((context as any).from_system_id).toBe('child-alias');

    expect(routeManager.downstreamRoutes.get('child-alias')).toBe(connector);
    const storedRoutes = await routeManager._downstream_route_store.list();
    expect(storedRoutes['child-alias']).toMatchObject({
      assignedPath: '/alias/path',
      connectorConfig: expect.objectContaining({ durable: true }),
      callbackGrants: [{ type: 'webhook' }],
    });

    const ackEnvelope = (connector.send as jest.Mock).mock
      .calls[0][0] as FameEnvelope;
    const ackFrame = ackEnvelope.frame as any;
    expect(ackFrame.assignedPath).toBe('/alias/path');
    expect(ackFrame.assigned_path).toBe('/alias/path');
    expect(ackFrame.routing_epoch).toBe('epoch-1');
    expect(ackFrame.stickiness.supportedModes).toEqual(['aft']);
    expect(ackFrame.stickiness.supported_modes).toEqual(['aft']);
    expect(ackFrame.stickiness.version).toBe(2);
    expect(ackEnvelope.corrId).toBe('corr-alias');
  });

  it('retains routing epoch when rebind occurs', async () => {
    const connector = createConnector();
    const routingNode = createRoutingNode();
    const bumpRoutingEpoch = jest.fn();
    (routingNode as any).bumpRoutingEpoch = bumpRoutingEpoch;

    const routeManager = new RouteManager({
      deliver: jest.fn(async () => undefined),
      getId: () => 'parent-node',
    });

    const existingConnector = createConnector();
    routeManager.downstreamRoutes.set('child-node', existingConnector);

    jest
      .spyOn(routeManager, 'unregisterDownstreamRoute')
      .mockResolvedValue(undefined);
    jest
      .spyOn(routeManager, 'registerDownstreamRoute')
      .mockResolvedValue(undefined);

    routeManager._pending_routes.set('child-node', {
      connector,
      attached: { set: jest.fn(), wait: jest.fn() },
      buffer: [],
    });
    routeManager._pending_route_metadata.set('child-node', {
      type: 'websocket',
      durable: false,
    });

    const handler = new NodeAttachFrameHandler({
      routingNode,
      routeManager,
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-node',
    } as NodeAttachFrame;

    const envelope = {
      id: 'env-reattach',
      frame,
    } as unknown as FameEnvelope;

    const context = createContext(connector);

    await handler.acceptNodeAttach(envelope, context);

    expect(bumpRoutingEpoch).not.toHaveBeenCalled();

    const ackEnvelope = (connector.send as jest.Mock).mock
      .calls[0][0] as FameEnvelope;
    expect(ackEnvelope.frame).toMatchObject({
      type: 'NodeAttachAck',
      routingEpoch: 'epoch-1',
    });
  });

  it('rejects attachment and schedules connector close when key validation fails', async () => {
    jest.useFakeTimers();

    const connector = createConnector();
    const routingNode = createRoutingNode();
    const routeManager = new RouteManager({
      deliver: jest.fn(async () => undefined),
      getId: () => 'parent-node',
    });

    routeManager._pending_routes.set('child-node', {
      connector,
      attached: { set: jest.fn(), wait: jest.fn() },
      buffer: [],
    });
    routeManager._pending_route_metadata.set('child-node', {
      type: 'websocket',
      durable: false,
    });

    const validator = {
      validateKeys: jest.fn(async () => {
        throw new KeyValidationError('invalid', 'certificate error');
      }),
    } as unknown as AttachmentKeyValidator;

    const stickinessManager: LoadBalancerStickinessManager = {
      negotiate: jest.fn(() => null),
      getStickyReplicaSegment: jest.fn(() => null),
    };

    const handler = new NodeAttachFrameHandler({
      routingNode,
      routeManager,
      attachmentKeyValidator: validator,
      stickinessManager,
    });

    const frame: NodeAttachFrame = {
      type: 'NodeAttach',
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: 'child-node',
      instanceId: 'child-instance',
    } as NodeAttachFrame;

    const envelope = {
      id: 'env-attach',
      corrId: 'corr-123',
      frame,
    } as unknown as FameEnvelope;

    const context = createContext(connector);

    await handler.acceptNodeAttach(envelope, context);

    expect(connector.send).toHaveBeenCalledTimes(1);
    const rejectionAck = (connector.send as jest.Mock).mock
      .calls[0][0] as FameEnvelope;
    expect(rejectionAck.frame).toMatchObject({
      type: 'NodeAttachAck',
      ok: false,
      reason: expect.stringContaining('Certificate validation failed'),
    });

    expect(routeManager.downstreamRoutes.has('child-node')).toBe(false);

    await Promise.resolve();
    jest.advanceTimersByTime(100_000);
    await handler.shutdownTasks({
      gracePeriod: 0,
      cancelHanging: true,
      joinTimeout: 0,
    });

    expect(connector.close).toHaveBeenCalledWith(1008, 'attach-unauthorized');

    jest.useRealTimers();
  });
});
