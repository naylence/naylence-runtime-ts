import { HttpStatelessConnectorFactory } from '../http-stateless-connector-factory.js';
import { HTTP_CONNECTION_GRANT_TYPE } from '../../grants/http-connection-grant.js';
import { AuthInjectionStrategyFactory } from '../../security/auth/auth-injection-strategy-factory.js';
import { ExpressionEvaluationPolicy } from '@naylence/factory';

describe('HttpStatelessConnectorFactory', () => {
  const factory = new HttpStatelessConnectorFactory();
  let authFactorySpy: jest.SpyInstance;

  beforeEach(() => {
    authFactorySpy = jest
      .spyOn(AuthInjectionStrategyFactory, 'createAuthInjectionStrategy')
      .mockResolvedValue({
        apply: async () => undefined,
        cleanup: async () => undefined,
      });
  });

  afterEach(() => {
    authFactorySpy.mockRestore();
  });

  it('converts grants to config', () => {
    const config = factory.configFromGrant(
      {
        type: HTTP_CONNECTION_GRANT_TYPE,
        purpose: 'connection',
        url: 'https://downstream.example',
        auth: { type: 'NoAuth' },
      },
      ExpressionEvaluationPolicy.ERROR
    );

    expect(config).toEqual({
      type: 'HttpStatelessConnector',
      url: 'https://downstream.example',
      auth: { type: 'NoAuth' },
    });
  });

  it('converts config back to grants', () => {
    const grant = factory.grantFromConfig(
      {
        type: 'HttpStatelessConnector',
        url: 'https://downstream.example',
        auth: { type: 'NoAuth' },
      },
      ExpressionEvaluationPolicy.ERROR
    );

    expect(grant).toEqual({
      type: HTTP_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
      url: 'https://downstream.example',
      auth: { type: 'NoAuth' },
    });
  });

  it('creates connectors and applies auth strategy', async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    const cleanup = jest.fn().mockResolvedValue(undefined);
    authFactorySpy.mockResolvedValue({ apply, cleanup });

    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

    const connector = await factory.create(
      {
        type: 'HttpStatelessConnector',
        url: 'https://listener.example/downstream',
        auth: { type: 'BearerToken', headerName: 'Authorization' },
      },
      {
        systemId: 'child-123',
        authorization: {
          authenticated: true,
        } as any,
        fetchImplementation: fetchMock,
      }
    );

    expect(apply).toHaveBeenCalledWith(connector);
    expect(connector.authorizationContext).toEqual({
      authenticated: true,
    });

    await connector['_transportSendBytes'](new Uint8Array([0x1]));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://listener.example/downstream/child-123',
      expect.any(Object)
    );

    await connector.close();
    expect(cleanup).toHaveBeenCalled();
  });
});
