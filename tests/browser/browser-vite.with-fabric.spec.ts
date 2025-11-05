import { describe, expect, it } from 'vitest';
import {
  createFameEnvelope,
  generateIdAsync,
  getNode,
  operation,
  RpcMixin,
  RpcProxy,
  withFabric,
} from '@naylence/runtime';

type RpcParams = { a: number; b: number };

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

  it('serves calculator RPCs via withFabric', async () => {
    const outcome = await withFabric(fabricConfig, async (fabric) => {
      const node = getNode();
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
});
