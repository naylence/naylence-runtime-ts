import {
  getAllowedKeyTypesFromEnv,
  resolveServerAddress,
} from '../node-welcome-server-env.js';

describe('nodeWelcomeServer environment normalization', () => {
  it('prefers snake_case values for allowed key types when provided', () => {
    const env = { FAME_JWKS_KEY_TYPES: 'RSA, EC' } as NodeJS.ProcessEnv;
    expect(getAllowedKeyTypesFromEnv(env)).toEqual(['RSA', 'EC']);
  });

  it('accepts camelCase values for allowed key types', () => {
    const env = { fameJwksKeyTypes: ' rsa  \n ec  ' } as NodeJS.ProcessEnv;
    expect(getAllowedKeyTypesFromEnv(env)).toEqual(['rsa', 'ec']);
  });

  it('returns null when no usable key types are provided', () => {
    const env = { FAME_JWKS_KEY_TYPES: ' , , ' } as NodeJS.ProcessEnv;
    expect(getAllowedKeyTypesFromEnv(env)).toBeNull();
  });

  it('resolves host and port from snake_case values', () => {
    const env = {
      FAME_APP_HOST: '127.0.0.1',
      FAME_APP_PORT: '9000',
    } as NodeJS.ProcessEnv;
    expect(resolveServerAddress(env)).toEqual({
      host: '127.0.0.1',
      port: 9000,
    });
  });

  it('supports camelCase aliases and falls back when port invalid', () => {
    const env = {
      fameAppHost: 'localhost',
      fameAppPort: 'not-a-number',
    } as NodeJS.ProcessEnv;
    expect(resolveServerAddress(env)).toEqual({
      host: 'localhost',
      port: 8090,
    });
  });
});
