import { CredentialProviderFactory } from '../credential/credential-provider-factory.js';
import {
  type EnvCredentialProviderConfig,
  normalizeEnvConfig,
} from '../credential/env-credential-provider-factory.js';
import {
  type PromptCredentialProviderConfig,
  normalizePromptConfig,
} from '../credential/prompt-credential-provider-factory.js';
import {
  type SecretStoreCredentialProviderConfig,
  normalizeSecretStoreConfig,
} from '../credential/secret-store-credential-provider-factory.js';
import {
  type StaticCredentialProviderConfig,
  normalizeStaticConfig,
} from '../credential/static-credential-provider-factory.js';
import { EnvCredentialProvider } from '../credential/env-credential-provider.js';
import { NoneCredentialProvider } from '../credential/none-credential-provider.js';
import { PromptCredentialProvider } from '../credential/prompt-credential-provider.js';
import {
  SecretSource,
  normalizeSecretSource,
} from '../credential/secret-source.js';
import { SecretStoreCredentialProvider } from '../credential/secret-store-credential-provider.js';
import { StaticCredentialProvider } from '../credential/static-credential-provider.js';

jest.mock('readline', () => {
  const createInterface = jest.fn();
  return {
    __esModule: true,
    createInterface,
    default: { createInterface },
  };
});

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }

  delete (globalThis as Record<string, unknown>).ENV;
  delete (globalThis as Record<string, unknown>).env;
  delete (globalThis as Record<string, unknown>).prompt;
  jest.restoreAllMocks();
});

describe('SecretSource.normalize', () => {
  it('throws when provided value is null or undefined', () => {
    expect(() => SecretSource.normalize(null as unknown as string)).toThrow(
      'Secret source cannot be null or undefined'
    );

    expect(() =>
      SecretSource.normalize(undefined as unknown as string)
    ).toThrow('Secret source cannot be null or undefined');
  });

  it('normalizes explicit credential provider config objects', () => {
    const staticConfig: StaticCredentialProviderConfig = {
      type: 'StaticCredentialProvider',
      credentialValue: 'abc',
    };
    const envConfig: EnvCredentialProviderConfig = {
      type: 'EnvCredentialProvider',
      varName: 'TOKEN_VAR',
    };
    const promptConfig: PromptCredentialProviderConfig = {
      type: 'PromptCredentialProvider',
      credentialName: 'apiToken',
    };
    const secretConfig: SecretStoreCredentialProviderConfig = {
      type: 'SecretStoreCredentialProvider',
      secretName: 'my-secret',
    };

    expect(SecretSource.normalize(staticConfig)).toEqual(staticConfig);
    expect(SecretSource.normalize(envConfig)).toEqual(envConfig);
    expect(SecretSource.normalize(promptConfig)).toEqual(promptConfig);
    expect(SecretSource.normalize(secretConfig)).toEqual(secretConfig);
  });

  it('returns shallow copy for unknown credential provider config types', () => {
    const customConfig = { type: 'CustomProvider', extra: 1 };
    const result = SecretSource.normalize(customConfig);

    expect(result).not.toBe(customConfig);
    expect(result).toEqual(customConfig);
  });

  it('parses env:// URI strings and validates variable names', () => {
    const config = SecretSource.normalize('env://API_TOKEN');
    expect(config).toEqual({
      type: 'EnvCredentialProvider',
      varName: 'API_TOKEN',
    });

    expect(() => SecretSource.normalize('env://')).toThrow(
      "Environment variable name cannot be empty in 'env://' URI"
    );
  });

  it('parses secret:// URI strings and validates secret names', () => {
    const config = SecretSource.normalize('secret://vault/credential');
    expect(config).toEqual({
      type: 'SecretStoreCredentialProvider',
      secretName: 'vault/credential',
    });

    expect(() => SecretSource.normalize('secret://')).toThrow(
      "Secret name cannot be empty in 'secret://' URI"
    );
  });

  it('creates static config for non-prefixed string inputs', () => {
    const config = SecretSource.normalize('plain-token');
    expect(config).toEqual({
      type: 'StaticCredentialProvider',
      credentialValue: 'plain-token',
    });
  });

  it('normalizes record inputs with snake_case keys', () => {
    const normalized = SecretSource.normalize({
      type: 'SecretStoreCredentialProvider',
      secret_name: 'under_score',
    });

    expect(normalized).toEqual({
      type: 'SecretStoreCredentialProvider',
      secretName: 'under_score',
    });
  });

  it('throws for record inputs without a type field', () => {
    expect(() => SecretSource.normalize({})).toThrow(
      "Secret source dict inputs must include a string 'type' field"
    );
  });

  it('returns shallow copy for record inputs with unknown type', () => {
    const raw = { type: 'CustomProvider', extra: 'info' };
    const normalized = SecretSource.normalize(raw);

    expect(normalized).not.toBe(raw);
    expect(normalized).toEqual(raw);
  });

  it('delegates through normalizeSecretSource helper', () => {
    const config = normalizeSecretSource('env://DELEGATED');
    expect(config).toEqual({
      type: 'EnvCredentialProvider',
      varName: 'DELEGATED',
    });
  });

  it('throws for unsupported secret source value types', () => {
    expect(() => SecretSource.normalize(42 as unknown as string)).toThrow(
      "Unsupported secret source type: number. Expected string, dict with 'type' field, or CredentialProviderConfig instance."
    );
  });
});

describe('Normalization helpers', () => {
  it('normalizes static credential config variations', () => {
    expect(normalizeStaticConfig(null)).toEqual({
      type: 'StaticCredentialProvider',
      credentialValue: '',
    });

    expect(
      normalizeStaticConfig({
        type: 'StaticCredentialProvider',
        credentialValue: 'token',
      })
    ).toEqual({ type: 'StaticCredentialProvider', credentialValue: 'token' });

    expect(
      normalizeStaticConfig({
        type: 'StaticCredentialProvider',
        credential_value: 'legacy',
      })
    ).toEqual({ type: 'StaticCredentialProvider', credentialValue: 'legacy' });

    expect(() =>
      normalizeStaticConfig({ type: 'StaticCredentialProvider' })
    ).toThrow('StaticCredentialProvider requires a "credentialValue" string');
  });

  it('normalizes environment credential config variations', () => {
    expect(normalizeEnvConfig(null)).toEqual({
      type: 'EnvCredentialProvider',
      varName: 'DEFAULT_VAR',
    });

    expect(
      normalizeEnvConfig({
        type: 'EnvCredentialProvider',
        varName: 'TOKEN_VAR',
      })
    ).toEqual({
      type: 'EnvCredentialProvider',
      varName: 'TOKEN_VAR',
    });

    expect(
      normalizeEnvConfig({
        type: 'EnvCredentialProvider',
        var_name: 'legacy_var',
      })
    ).toEqual({
      type: 'EnvCredentialProvider',
      varName: 'legacy_var',
    });

    expect(() =>
      normalizeEnvConfig({ type: 'EnvCredentialProvider', varName: '' })
    ).toThrow('EnvCredentialProvider requires a non-empty "varName"');
  });

  it('normalizes secret store credential config variations', () => {
    expect(normalizeSecretStoreConfig(null)).toEqual({
      type: 'SecretStoreCredentialProvider',
      secretName: 'default',
    });

    expect(
      normalizeSecretStoreConfig({
        type: 'SecretStoreCredentialProvider',
        secretName: 'vault',
      })
    ).toEqual({ type: 'SecretStoreCredentialProvider', secretName: 'vault' });

    expect(
      normalizeSecretStoreConfig({
        type: 'SecretStoreCredentialProvider',
        secret_name: 'legacy',
      })
    ).toEqual({ type: 'SecretStoreCredentialProvider', secretName: 'legacy' });

    expect(() =>
      normalizeSecretStoreConfig({
        type: 'SecretStoreCredentialProvider',
        secretName: '',
      })
    ).toThrow(
      'SecretStoreCredentialProvider requires a non-empty "secretName"'
    );
  });

  it('normalizes prompt credential config variations', () => {
    expect(normalizePromptConfig(null)).toEqual({
      type: 'PromptCredentialProvider',
      credentialName: 'credential',
    });

    expect(
      normalizePromptConfig({
        type: 'PromptCredentialProvider',
        credentialName: 'apiToken',
      })
    ).toEqual({ type: 'PromptCredentialProvider', credentialName: 'apiToken' });

    expect(
      normalizePromptConfig({
        type: 'PromptCredentialProvider',
        credential_name: 'legacy',
      })
    ).toEqual({ type: 'PromptCredentialProvider', credentialName: 'legacy' });

    expect(() =>
      normalizePromptConfig({
        type: 'PromptCredentialProvider',
        credentialName: '',
      })
    ).toThrow('PromptCredentialProvider requires a non-empty "credentialName"');
  });
});

describe('EnvCredentialProvider', () => {
  it('returns string values from environment variables', async () => {
    process.env.API_TOKEN = 'secret';
    const provider = new EnvCredentialProvider('API_TOKEN');

    await expect(provider.get()).resolves.toBe('secret');
  });

  it('coerces non-string environment entries and supports ENV fallback', async () => {
    delete process.env.DERIVED_TOKEN;
    (globalThis as Record<string, unknown>).ENV = { DERIVED_TOKEN: 123 }; // coverage: non-string path

    const provider = new EnvCredentialProvider('DERIVED_TOKEN');
    await expect(provider.get()).resolves.toBe('123');
  });

  it('coerces non-string values sourced from process.env', async () => {
    Object.defineProperty(process.env, 'OBJECT_TOKEN', {
      configurable: true,
      enumerable: true,
      value: { key: 'value' } as unknown as string,
      writable: true,
    });

    const provider = new EnvCredentialProvider('OBJECT_TOKEN');
    await expect(provider.get()).resolves.toBe('[object Object]');

    delete (process.env as Record<string, unknown>).OBJECT_TOKEN;
  });

  it('falls back to lowercase env map when available', async () => {
    delete process.env.LOWER_TOKEN;
    (globalThis as Record<string, unknown>).env = { LOWER_TOKEN: 'fallback' };

    const provider = new EnvCredentialProvider('LOWER_TOKEN');
    await expect(provider.get()).resolves.toBe('fallback');
  });

  it('returns null when variable is missing', async () => {
    const provider = new EnvCredentialProvider('UNKNOWN_TOKEN');
    await expect(provider.get()).resolves.toBeNull();
  });

  it('throws when instantiated with an empty variable name', () => {
    expect(() => new EnvCredentialProvider('')).toThrow(
      'Environment variable name must not be empty'
    );
  });
});

describe('StaticCredentialProvider', () => {
  it('returns the configured credential value', async () => {
    const provider = new StaticCredentialProvider('static-value');
    await expect(provider.get()).resolves.toBe('static-value');
  });
});

describe('SecretStoreCredentialProvider', () => {
  it('resolves to null while retaining secret name metadata', async () => {
    const provider = new SecretStoreCredentialProvider('service/credential');
    await expect(provider.get()).resolves.toBeNull();
  });

  it('throws when instantiated without a secret name', () => {
    expect(() => new SecretStoreCredentialProvider('')).toThrow(
      'Secret store credential provider requires a secret name'
    );
  });
});

describe('NoneCredentialProvider', () => {
  it('always resolves to null', async () => {
    const provider = new NoneCredentialProvider();
    await expect(provider.get()).resolves.toBeNull();
  });
});

describe('PromptCredentialProvider', () => {
  it('trims resolver output and caches the result', async () => {
    const resolver = jest.fn().mockResolvedValue('  resolved-value  ');
    const provider = new PromptCredentialProvider('apiCredential', resolver);

    const first = await provider.get();
    const second = await provider.get();

    expect(first).toBe('resolved-value');
    expect(second).toBe('resolved-value');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('treats blank resolver responses as null', async () => {
    const provider = new PromptCredentialProvider(
      'apiCredential',
      async () => '   '
    );
    await expect(provider.get()).resolves.toBeNull();
  });

  it('returns null when resolver throws an error', async () => {
    const provider = new PromptCredentialProvider('apiCredential', async () => {
      throw new Error('failure');
    });

    await expect(provider.get()).resolves.toBeNull();
  });

  it('caches null results from resolvers returning nullish values', async () => {
    const resolver = jest.fn().mockResolvedValue(null);
    const provider = new PromptCredentialProvider('apiCredential', resolver);

    const first = await provider.get();
    const second = await provider.get();

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('normalizes non-string resolver results to null', async () => {
    const provider = new PromptCredentialProvider(
      'apiCredential',
      async () => 0 as unknown as string
    );
    await expect(provider.get()).resolves.toBeNull();
  });

  it('falls back to global prompt when available', async () => {
    const promptMock = jest.fn().mockReturnValue('  prompted-value  ');
    (globalThis as Record<string, unknown>).prompt = promptMock;

    const provider = new PromptCredentialProvider('apiCredential');
    await expect(provider.get()).resolves.toBe('prompted-value');
    expect(promptMock).toHaveBeenCalledWith(
      "Enter credential 'apiCredential': "
    );
  });

  it('returns null when global prompt does not provide a string', async () => {
    const promptMock = jest.fn().mockReturnValue(undefined);
    (globalThis as Record<string, unknown>).prompt = promptMock;

    const provider = new PromptCredentialProvider('apiCredential');
    await expect(provider.get()).resolves.toBeNull();
    expect(promptMock).toHaveBeenCalledWith(
      "Enter credential 'apiCredential': "
    );
  });

  it('uses readline fallback when terminal IO is available', async () => {
    delete (globalThis as Record<string, unknown>).prompt;
    const readline = await import('readline');

    const closeMock = jest.fn();
    const questionMock = jest.fn((_: string, cb: (answer: string) => void) => {
      cb('  cli-value  ');
    });

    (readline.createInterface as jest.Mock).mockReturnValueOnce({
      question: questionMock,
      close: closeMock,
    } as unknown as import('readline').Interface);

    const provider = new PromptCredentialProvider('apiCredential');
    const result = await (
      provider as unknown as {
        promptCredential(): Promise<string | null>;
      }
    ).promptCredential();

    expect(result).toBe('cli-value');
    expect(readline.createInterface).toHaveBeenCalled();

    (readline.createInterface as jest.Mock).mockReset();
  });

  it('returns null when readline setup fails', async () => {
    delete (globalThis as Record<string, unknown>).prompt;
    const readline = await import('readline');

    (readline.createInterface as jest.Mock).mockImplementationOnce(() => {
      throw new Error('no tty');
    });

    const provider = new PromptCredentialProvider('apiCredential');
    const result = await (
      provider as unknown as {
        promptCredential(): Promise<string | null>;
      }
    ).promptCredential();

    expect(result).toBeNull();

    (readline.createInterface as jest.Mock).mockReset();
  });

  it('returns null when no IO transport exists', async () => {
    const globalObject = globalThis as Record<string, unknown>;
    const originalProcess = globalObject.process;
    globalObject.process = {
      stdin: null,
      stdout: null,
    } as unknown as typeof process;

    try {
      const provider = new PromptCredentialProvider('apiCredential');
      delete globalObject.prompt;

      const result = await (
        provider as unknown as {
          promptCredential(): Promise<string | null>;
        }
      ).promptCredential();

      expect(result).toBeNull();
    } finally {
      globalObject.process = originalProcess;
    }
  });
});

describe('CredentialProviderFactory', () => {
  it('creates provider instances based on configuration', async () => {
    const staticProvider =
      await CredentialProviderFactory.createCredentialProvider({
        type: 'StaticCredentialProvider',
        credentialValue: 'factory-token',
      });
    expect(staticProvider).toBeInstanceOf(StaticCredentialProvider);
    await expect(staticProvider.get()).resolves.toBe('factory-token');

    const envProvider =
      await CredentialProviderFactory.createCredentialProvider({
        type: 'EnvCredentialProvider',
        varName: 'API_TOKEN',
      });
    expect(envProvider).toBeInstanceOf(EnvCredentialProvider);
  });

  it('creates default provider when configuration is absent', async () => {
    const provider =
      await CredentialProviderFactory.createCredentialProvider(null);
    expect(provider).toBeInstanceOf(NoneCredentialProvider);
    await expect(provider.get()).resolves.toBeNull();
  });
});
