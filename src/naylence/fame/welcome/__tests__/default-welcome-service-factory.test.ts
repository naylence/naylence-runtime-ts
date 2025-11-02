import { DefaultWelcomeServiceFactory } from '../default-welcome-service-factory.js';
import type { DefaultWelcomeServiceConfig } from '../default-welcome-service-factory.js';
import { NodePlacementStrategyFactory } from '../../placement/node-placement-strategy-factory.js';
import { TransportProvisionerFactory } from '../../transport/transport-provisioner.js';
import { TokenIssuerFactory } from '../../security/auth/token-issuer-factory.js';
import { AuthorizerFactory } from '../../security/auth/authorizer-factory.js';
import { DefaultWelcomeService } from '../default-welcome-service.js';

const placementStrategyStub = { id: 'placement-strategy' };
const transportProvisionerStub = { id: 'transport-provisioner' };
const tokenIssuerStub = { id: 'token-issuer' };
const authorizerStub = { id: 'authorizer' };
const serviceInstanceStub = { id: 'welcome-service' };

jest.mock('../../placement/node-placement-strategy-factory.js', () => ({
  NodePlacementStrategyFactory: {
    createNodePlacementStrategy: jest.fn(),
  },
}));

jest.mock('../../transport/transport-provisioner.js', () => ({
  TransportProvisionerFactory: {
    createTransportProvisioner: jest.fn(),
  },
}));

jest.mock('../../security/auth/token-issuer-factory.js', () => ({
  TokenIssuerFactory: {
    createTokenIssuer: jest.fn(),
  },
}));

jest.mock('../../security/auth/authorizer-factory.js', () => ({
  AuthorizerFactory: {
    createAuthorizer: jest.fn(),
  },
}));

jest.mock('../default-welcome-service.js', () => ({
  DefaultWelcomeService: jest.fn(),
}));

const createNodePlacementStrategyMock =
  NodePlacementStrategyFactory.createNodePlacementStrategy as jest.Mock;
const createTransportProvisionerMock =
  TransportProvisionerFactory.createTransportProvisioner as jest.Mock;
const createTokenIssuerMock = TokenIssuerFactory.createTokenIssuer as jest.Mock;
const createAuthorizerMock = AuthorizerFactory.createAuthorizer as jest.Mock;
const defaultWelcomeServiceCtor = DefaultWelcomeService as unknown as jest.Mock;

describe('DefaultWelcomeServiceFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createNodePlacementStrategyMock.mockResolvedValue(placementStrategyStub);
    createTransportProvisionerMock.mockResolvedValue(transportProvisionerStub);
    createTokenIssuerMock.mockResolvedValue(tokenIssuerStub);
    createAuthorizerMock.mockResolvedValue(authorizerStub);
    defaultWelcomeServiceCtor.mockReturnValue(serviceInstanceStub);
  });

  it('supports camelCase configuration aliases', async () => {
    const factory = new DefaultWelcomeServiceFactory();

    const config = {
      type: 'DefaultWelcomeService',
      placementConfig: { kind: 'camel-placement' },
      transportProvisioner: { kind: 'camel-transport' },
      tokenIssuer: { kind: 'camel-token' },
      authorizerConfig: { kind: 'camel-authorizer' },
      ttlSec: 600,
    } as unknown as DefaultWelcomeServiceConfig;

    const result = await factory.create(config);

    expect(createNodePlacementStrategyMock).toHaveBeenCalledWith(
      config.placementConfig,
      undefined
    );
    expect(createTransportProvisionerMock).toHaveBeenCalledWith(
      config.transportProvisioner,
      undefined
    );
    expect(createTokenIssuerMock).toHaveBeenCalledWith(
      config.tokenIssuer,
      undefined
    );
    expect(createAuthorizerMock).toHaveBeenCalledWith(config.authorizerConfig, {
      factoryArgs: [],
    });
    expect(defaultWelcomeServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        placementStrategy: placementStrategyStub,
        transportProvisioner: transportProvisionerStub,
        tokenIssuer: tokenIssuerStub,
        authorizer: authorizerStub,
        ttlSec: 600,
      })
    );
    expect(result).toBe(serviceInstanceStub);
  });

  it('supports snake_case configuration aliases', async () => {
    const factory = new DefaultWelcomeServiceFactory();

    const config = {
      type: 'DefaultWelcomeService',
      placement: { kind: 'snake-placement' },
      transport_provisioner: { kind: 'snake-transport' },
      token_issuer: { kind: 'snake-token' },
      authorizer_config: { kind: 'snake-authorizer' },
      ttl_sec: 180,
    } as unknown as DefaultWelcomeServiceConfig;

    const result = await factory.create(config);

    expect(createNodePlacementStrategyMock).toHaveBeenCalledWith(
      config.placement,
      undefined
    );
    expect(createTransportProvisionerMock).toHaveBeenCalledWith(
      config.transport_provisioner,
      undefined
    );
    expect(createTokenIssuerMock).toHaveBeenCalledWith(
      config.token_issuer,
      undefined
    );
    expect(createAuthorizerMock).toHaveBeenCalledWith(
      config.authorizer_config,
      {
        factoryArgs: [],
      }
    );
    expect(defaultWelcomeServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlSec: 180,
      })
    );
    expect(result).toBe(serviceInstanceStub);
  });
});
