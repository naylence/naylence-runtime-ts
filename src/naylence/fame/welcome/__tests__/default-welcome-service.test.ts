import type { NodeHelloFrame } from '@naylence/core';

import type {
  NodePlacementStrategy,
  PlacementDecision,
} from '../../placement/node-placement-strategy.js';
import type {
  TransportProvisioner,
  TransportProvisionResult,
} from '../../transport/transport-provisioner.js';
import type { TokenIssuer } from '../../security/auth/token-issuer.js';
import type { Authorizer } from '../../security/auth/authorizer.js';
import {
  DefaultWelcomeService,
  type DefaultWelcomeServiceOptions,
  resolveShowEnvelopesFlag,
} from '../default-welcome-service.js';

interface MockContext {
  placementStrategy: NodePlacementStrategy & { place: jest.Mock }; // augment with mock typing
  transportProvisioner: TransportProvisioner & {
    provision: jest.Mock<Promise<TransportProvisionResult>, any>;
    deprovision: jest.Mock<Promise<void>, any>;
  };
  tokenIssuer: TokenIssuer & { issue: jest.Mock<Promise<string>, any> };
  authorizer: Authorizer | null;
  service: DefaultWelcomeService;
}

function createMockContext(options?: {
  placementDecision?: PlacementDecision;
  authorizer?: Authorizer | null;
  ttlSec?: number;
}): MockContext {
  const placementDecision: PlacementDecision = options?.placementDecision ?? {
    accept: true,
    assignedPath: '/fabric/node-1',
    targetSystemId: 'parent-001',
    targetPhysicalPath: '/fabric/parent',
    metadata: {
      acceptedCapabilities: ['cap-from-placement'],
      acceptedLogicals: ['api.service'],
    },
  };

  const placementStrategy: NodePlacementStrategy & { place: jest.Mock } = {
    place: jest.fn(async () => placementDecision),
  };

  const transportProvisioner: TransportProvisioner & {
    provision: jest.Mock<Promise<TransportProvisionResult>, any>;
    deprovision: jest.Mock<Promise<void>, any>;
  } = {
    provision: jest.fn(
      async () =>
        ({
          connectionGrant: {
            type: 'WebSocketConnectionGrant',
            url: 'wss://example',
          },
          cleanupHandle: null,
          metadata: null,
        }) satisfies TransportProvisionResult
    ),
    deprovision: jest.fn(async () => undefined),
  };

  const tokenIssuer: TokenIssuer & { issue: jest.Mock<Promise<string>, any> } =
    {
      issuer: 'issuer-1',
      issue: jest.fn(async () => 'attach-token-123'),
    };

  const authorizer = options?.authorizer ?? null;

  const serviceOptions: DefaultWelcomeServiceOptions = {
    placementStrategy,
    transportProvisioner,
    tokenIssuer,
    authorizer,
  };

  if (options?.ttlSec !== undefined) {
    serviceOptions.ttlSec = options.ttlSec;
  }

  const service = new DefaultWelcomeService(serviceOptions);

  return {
    placementStrategy,
    transportProvisioner,
    tokenIssuer,
    authorizer,
    service,
  };
}

function createHelloFrame(
  overrides: Partial<NodeHelloFrame> = {}
): NodeHelloFrame {
  return {
    type: 'NodeHello',
    systemId: overrides.systemId ?? '',
    instanceId: overrides.instanceId ?? 'instance-1',
    logicals: overrides.logicals ?? ['api.service'],
    capabilities: overrides.capabilities ?? ['cap-a'],
    supportedTransports: overrides.supportedTransports ?? ['websocket'],
    securitySettings: overrides.securitySettings,
  } satisfies NodeHelloFrame;
}

describe('DefaultWelcomeService', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it('assigns systemId when missing and provisions transport', async () => {
    const context = createMockContext();
    const hello = createHelloFrame({ systemId: '' });

    const welcome = await context.service.handleHello(hello);

    expect(welcome.systemId).toBeTruthy();
    expect(welcome.connectionGrants).toHaveLength(1);
    expect(context.tokenIssuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        assigned_path: '/fabric/node-1',
        parent_path: '/fabric/parent',
      })
    );
    expect(context.transportProvisioner.provision).toHaveBeenCalledWith(
      expect.objectContaining({ accept: true }),
      expect.objectContaining({ systemId: welcome.systemId }),
      expect.objectContaining({ instanceId: 'instance-1' }),
      expect.any(String)
    );
    expect(welcome.acceptedCapabilities).toEqual(['cap-from-placement']);
    expect(welcome.acceptedLogicals).toEqual(['api.service']);
    expect(typeof welcome.expiresAt).toBe('string');
    const firstExpiresAt = welcome.expiresAt;
    expect(firstExpiresAt).toBeTruthy();
    expect(Date.parse(firstExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it('respects custom ttl configuration', async () => {
    const ttlSec = 120;
    const context = createMockContext({ ttlSec });
    const welcome = await context.service.handleHello(createHelloFrame());

    const expiresAtMs = Date.parse(welcome.expiresAt ?? '');
    expect(Number.isFinite(expiresAtMs)).toBe(true);
    const deltaMs = expiresAtMs - Date.now();
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThanOrEqual((ttlSec + 5) * 1000);
  });

  it('accepts snake_case ttl_sec option alias', async () => {
    const base = createMockContext();
    const service = new DefaultWelcomeService({
      placementStrategy: base.placementStrategy,
      transportProvisioner: base.transportProvisioner,
      tokenIssuer: base.tokenIssuer,
      authorizer: base.authorizer,
      ttl_sec: 240,
    } as DefaultWelcomeServiceOptions & { ttl_sec: number });

    const welcome = await service.handleHello(createHelloFrame());
    const expiresAtMs = Date.parse(welcome.expiresAt ?? '');
    expect(Number.isFinite(expiresAtMs)).toBe(true);
    const deltaMs = expiresAtMs - Date.now();
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThanOrEqual((240 + 5) * 1000);
  });

  it('throws when logicals are invalid', async () => {
    const context = createMockContext();
    const hello = createHelloFrame({
      logicals: ['invalid logical with spaces'],
    });

    await expect(context.service.handleHello(hello)).rejects.toThrow(
      'Invalid logical format'
    );
    expect(context.placementStrategy.place).not.toHaveBeenCalled();
  });

  it('throws when placement rejects node', async () => {
    const placementDecision: PlacementDecision = {
      accept: false,
      assignedPath: '/fabric/rejected',
      reason: 'No capacity',
    };
    const context = createMockContext({ placementDecision });

    await expect(
      context.service.handleHello(createHelloFrame())
    ).rejects.toThrow('No capacity');

    expect(context.tokenIssuer.issue).not.toHaveBeenCalled();
    expect(context.transportProvisioner.provision).not.toHaveBeenCalled();
  });

  it('skips token issuance when targetSystemId is absent', async () => {
    const placementDecision: PlacementDecision = {
      accept: true,
      assignedPath: '/fabric/node-1',
      targetSystemId: null,
      metadata: {
        acceptedCapabilities: ['cap-from-placement'],
      },
    };
    const context = createMockContext({ placementDecision });

    const welcome = await context.service.handleHello(createHelloFrame());

    expect(context.tokenIssuer.issue).not.toHaveBeenCalled();
    expect(context.transportProvisioner.provision).not.toHaveBeenCalled();
    expect(welcome.connectionGrants).toHaveLength(0);
  });
});

describe('resolveShowEnvelopesFlag', () => {
  it('returns true for snake_case env flag', () => {
    expect(
      resolveShowEnvelopesFlag({
        FAME_SHOW_ENVELOPES: 'true',
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it('accepts camelCase alias for env flag', () => {
    expect(
      resolveShowEnvelopesFlag({
        fameShowEnvelopes: 'true',
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it('returns false when flag absent or not true', () => {
    expect(resolveShowEnvelopesFlag(undefined)).toBe(false);
    expect(
      resolveShowEnvelopesFlag({
        FAME_SHOW_ENVELOPES: 'false',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});
