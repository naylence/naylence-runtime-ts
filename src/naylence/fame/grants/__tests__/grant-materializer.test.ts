import { GrantMaterializer } from '../grant-materializer.js';
import { TokenProviderFactory } from '../../security/auth/token-provider-factory.js';
import type { MaterializableTokenProvider } from '../../security/auth/materializable-token-provider.js';
import type { TokenProvider } from '../../security/auth/token-provider.js';

jest.mock('../../security/auth/token-provider-factory.js');

describe('GrantMaterializer', () => {
  it('should return grant as-is if no auth', async () => {
    const grant = { type: 'TestGrant' };
    const result = await GrantMaterializer.materialize(grant);
    expect(result).toEqual(grant);
  });

  it('should return grant as-is if no token provider', async () => {
    const grant = { type: 'TestGrant', auth: { type: 'NoAuth' } };
    const result = await GrantMaterializer.materialize(grant);
    expect(result).toEqual(grant);
  });

  it('should materialize if provider is materializable', async () => {
    const mockMaterialize = jest.fn().mockResolvedValue({
      type: 'StaticTokenProvider',
      token: 'materialized-token',
    });

    const mockProvider = {
      getToken: jest.fn(),
      materialize: mockMaterialize,
    } as unknown as MaterializableTokenProvider;

    (TokenProviderFactory.createTokenProvider as jest.Mock).mockResolvedValue(
      mockProvider
    );

    const grant = {
      type: 'TestGrant',
      auth: {
        type: 'SomeAuth',
        tokenProvider: { type: 'MaterializableProvider' },
      },
    };

    const result = await GrantMaterializer.materialize(grant);

    expect(mockMaterialize).toHaveBeenCalled();
    expect((result as any).auth.tokenProvider).toEqual({
      type: 'StaticTokenProvider',
      token: 'materialized-token',
    });
  });

  it('should return grant as-is if provider is not materializable', async () => {
    const mockProvider = {
      getToken: jest.fn(),
    } as unknown as TokenProvider;

    (TokenProviderFactory.createTokenProvider as jest.Mock).mockResolvedValue(
      mockProvider
    );

    const grant = {
      type: 'TestGrant',
      auth: {
        type: 'SomeAuth',
        tokenProvider: { type: 'RegularProvider' },
      },
    };

    const result = await GrantMaterializer.materialize(grant);

    expect(result).toEqual(grant);
  });


});
