import { describe, expect, it } from 'vitest';
import {
  createFameEnvelope,
  generateIdAsync,
  operation,
  enableLogging,
  RpcMixin,
  RpcProxy,
  withFabric,
} from '@naylence/runtime';
import { BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE } from '../../src/naylence/fame/grants/broadcast-channel-connection-grant.js';
import type { NodeLike, RoutingNodeLike } from '@naylence/runtime';

enableLogging('debug');

type RpcParams = { a: number; b: number };

type WaitForOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitForCondition = async (
  predicate: () => boolean,
  options: WaitForOptions = {},
): Promise<void> => {
  const { timeoutMs = 5000, intervalMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
};

const waitForDownstreamRoute = async (
  routingNode: RoutingNodeLike,
  systemId: string,
  timeoutMs = 4000,
): Promise<void> => {
  const introspected = routingNode as RoutingNodeLike & {
    routeManager?: {
      downstreamRoutes?: Map<string, unknown>;
      _pending_routes?: Map<string, unknown>;
    };
  };

  try {
    await waitForCondition(
      () => Boolean(introspected.routeManager?.downstreamRoutes?.has(systemId)),
      { timeoutMs },
    );
  } catch (error) {
    const pending = Array.from(
      introspected.routeManager?._pending_routes?.keys() ?? [],
    );
    const pendingInfo =
      pending.length > 0
        ? `Pending routes: ${pending.join(', ')}`
        : 'No pending routes registered';
    const baseMessage =
      error instanceof Error ? error.message : String(error ?? 'unknown error');
    throw new Error(
      `${baseMessage}; downstream route for ${systemId} not ready. ${pendingInfo}`,
    );
  }
};

describe('browser-vite example', () => {
  class CalculatorService extends RpcMixin {
    public get capabilities(): string[] {
      return ['calculator', 'math'];
    }

    public async add(params: RpcParams): Promise<number> {
      return params.a + params.b;
    }
  }

  const addDescriptor = Object.getOwnPropertyDescriptor(
    CalculatorService.prototype,
    'add',
  );

  if (!addDescriptor) {
    throw new Error('Missing descriptor for CalculatorService.add');
  }

  operation()(CalculatorService.prototype, 'add', addDescriptor);

  const fabricConfig = {
    rootConfig: {
      plugins: ['@naylence/runtime'],
      node: {
        security: {
          type: 'DefaultSecurityManager',
          security_policy: {
            type: 'DefaultSecurityPolicy',
            signing: {
              signing_material: 'raw-key',
              inbound: {
                signature_policy: 'required',
                unsigned_violation_action: 'nack',
                invalid_signature_action: 'nack',
              },
              response: {
                mirror_request_signing: true,
                always_sign_responses: false,
                sign_error_responses: true,
              },
              outbound: {
                default_signing: true,
                sign_sensitive_operations: true,
                sign_if_recipient_expects: true,
              },
            },
            encryption: {
              inbound: {
                allow_plaintext: true,
                allow_channel: false,
                allow_sealed: false,
                plaintext_violation_action: 'nack',
                channel_violation_action: 'nack',
                sealed_violation_action: 'nack',
              },
              response: {
                mirror_request_level: false,
                minimum_response_level: 'plaintext',
                escalate_sealed_responses: false,
              },
              outbound: {
                default_level: 'plaintext',
                escalate_if_peer_supports: false,
                prefer_sealed_for_sensitive: false,
              },
            },
          },
        },
      },
    },
  } as const;

  const cloneSecurityConfig = () =>
    JSON.parse(JSON.stringify(fabricConfig.rootConfig.node.security));

  const buildFabricConfig = (
    nodeOverrides: Record<string, unknown>,
  ): { rootConfig: { plugins: string[]; node: Record<string, unknown> } } => ({
    rootConfig: {
      plugins: [...fabricConfig.rootConfig.plugins],
      node: {
        security: cloneSecurityConfig(),
        ...nodeOverrides,
      },
    },
  });

  it('serves calculator RPCs via withFabric', async () => {
    const outcome = await withFabric(fabricConfig, async (fabric) => {
      const node = (fabric as unknown as { node: NodeLike }).node;
      const calculator = new CalculatorService();
      const address = await fabric.serve(calculator, 'calculator');
      const proxy = RpcProxy.remoteByAddress(address) as unknown as {
        add(input: RpcParams): Promise<number>;
      };
      const addResult = await proxy.add({ a: 3, b: 4 });
      const generatedId = await generateIdAsync({ mode: 'fingerprint' });
      const envelope = createFameEnvelope({
        sid: node.sid ?? 'unknown',
        frame: {
          type: 'Data',
          payload: 'payload',
        },
      });
      const frame = envelope.frame;

      if (frame.type !== 'Data') {
        throw new Error('Unexpected envelope frame type');
      }

      const addressValue = Array.isArray(address)
        ? address.join('')
        : String(address);

      return {
        fabricCtor: fabric.constructor.name,
        nodeId: node.id,
        nodeSid: node.sid,
        address: addressValue,
        addResult,
        generatedId,
        envelopePayload: frame.payload,
      };
    });

    expect(outcome.fabricCtor).toMatch(/FameFabric$/);
    expect(outcome.nodeId).toBeTruthy();
    expect(outcome.nodeSid).toBeTruthy();
    expect(outcome.address).toContain('calculator');
    expect(outcome.addResult).toBe(7);
    expect(outcome.generatedId.length).toBeGreaterThan(0);
    expect(outcome.envelopePayload).toBe('payload');
  });

  it('connects a downstream fabric via direct in-page admission', async () => {
    const channelName = `naylence-inpage-${await generateIdAsync()}`;
    const childSystemId = await generateIdAsync();

    const sentinelConfig = buildFabricConfig({
      type: 'Sentinel',
      requestedLogicals: ['*'],
      listeners: [
        {
          type: 'InPageListener',
          channelName,
        },
      ],
      security: {
        type: 'DefaultSecurityManager',
        security_policy: {
          type: 'NoSecurityPolicy',
        },
        authorizer: {
          type: 'NoopAuthorizer',
        },
      },
    });

    const childAdmission = {
      type: 'DirectAdmissionClient',
      connectionGrants: [
        {
          type: 'InPageConnectionGrant',
          purpose: 'node.attach',
          channelName,
          ttl: 0,
          durable: false,
        },
      ]
    } as const;

    const childConfig = buildFabricConfig({
      hasParent: true,
      id: childSystemId,
      requestedLogicals: ['calculator'],
      security: {
        type: 'DefaultSecurityManager',
        security_policy: {
          type: 'NoSecurityPolicy',
        },
        authorizer: {
          type: 'NoopAuthorizer',
        },
      },
      admission: childAdmission,
    });

    await withFabric(sentinelConfig, async (sentinelFabric) => {
      const sentinelNode = (sentinelFabric as unknown as { node: NodeLike }).node;
      const calculator = new CalculatorService();
      const calculatorAddress = await sentinelFabric.serve(
        calculator,
        'calculator',
      );

      const childOutcome = await withFabric(childConfig, async (childFabric) => {
        const childNode = (childFabric as unknown as { node: NodeLike }).node;

        expect(childNode.id).toBe(childSystemId);

        const proxy = RpcProxy.remoteByAddress(
          calculatorAddress,
        ) as unknown as {
          add(input: RpcParams): Promise<number>;
        };

        const sum = await proxy.add({ a: 9, b: 4 });

        return {
          sum,
          childSid: childNode.sid,
        };
      });

      expect(childOutcome.sum).toBe(13);
      expect(childOutcome.childSid).toBeTruthy();
      expect(sentinelNode.sid).toBeTruthy();
    });
  }, 15000);

  it('connects a downstream fabric via broadcast channel admission', async () => {
    const channelName = `naylence-broadcast-${await generateIdAsync()}`;
    const childSystemId = await generateIdAsync();

    const sentinelConfig = buildFabricConfig({
      type: 'Sentinel',
      requestedLogicals: ['*'],
      listeners: [
        {
          type: 'BroadcastChannelListener',
          channelName,
        },
      ],
      security: {
        type: 'DefaultSecurityManager',
        security_policy: {
          type: 'NoSecurityPolicy',
        },
        authorizer: {
          type: 'NoopAuthorizer',
        },
      },
    });

    const childAdmission = {
      type: 'DirectAdmissionClient',
      connectionGrants: [
        {
          type: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
          purpose: 'node.attach',
          channelName,
          ttl: 0,
          durable: false,
        },
      ],
    } as const;

    const childConfig = buildFabricConfig({
      hasParent: true,
      id: childSystemId,
      requestedLogicals: ['calculator'],
      security: {
        type: 'DefaultSecurityManager',
        security_policy: {
          type: 'NoSecurityPolicy',
        },
        authorizer: {
          type: 'NoopAuthorizer',
        },
      },
      admission: childAdmission,
    });

    console.log('sentinel withFabric start');
    await withFabric(sentinelConfig, async (sentinelFabric) => {
      console.log('sentinel withFabric entered');
      const sentinelNode = (sentinelFabric as unknown as { node: NodeLike }).node;
      const calculator = new CalculatorService();
      const calculatorAddress = await sentinelFabric.serve(
        calculator,
        'calculator',
      );

      const childOutcome = await withFabric(childConfig, async (childFabric) => {
        console.log('child withFabric entered');
        const childNode = (childFabric as unknown as { node: NodeLike }).node;

        expect(childNode.id).toBe(childSystemId);

        const proxy = RpcProxy.remoteByAddress(
          calculatorAddress,
        ) as unknown as {
          add(input: RpcParams): Promise<number>;
        };

        const sum = await proxy.add({ a: 11, b: 6 });
        console.log('child rpc completed');

        return {
          sum,
          childSid: childNode.sid,
        };
      });
      console.log('child withFabric returned', childOutcome);

      expect(childOutcome.sum).toBe(17);
      expect(childOutcome.childSid).toBeTruthy();
      expect(sentinelNode.sid).toBeTruthy();
    });
    console.log('sentinel withFabric completed');
  }, 15000);
}
);
