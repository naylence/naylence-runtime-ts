import type { CredentialProvider } from './credential-provider.js';

function readEnvironmentVariable(name: string): string | undefined {
  if (!name) {
    return undefined;
  }

  const globalObject = typeof globalThis !== 'undefined' ? (globalThis as Record<string, unknown>) : {};
  const processObject = globalObject.process as { env?: Record<string, unknown> } | undefined;

  const fromProcess = processObject?.env ? processObject.env[name] : undefined;
  if (typeof fromProcess === 'string') {
    return fromProcess;
  }
  if (fromProcess !== undefined && fromProcess !== null) {
    return String(fromProcess);
  }

  const envObject = (globalObject.ENV ?? globalObject.env) as Record<string, unknown> | undefined;
  const fromEnv = envObject ? envObject[name] : undefined;
  if (typeof fromEnv === 'string') {
    return fromEnv;
  }
  if (fromEnv !== undefined && fromEnv !== null) {
    return String(fromEnv);
  }

  return undefined;
}

export class EnvCredentialProvider implements CredentialProvider {
  private readonly varName: string;

  constructor(varName: string) {
    if (!varName) {
      throw new Error('Environment variable name must not be empty');
    }
    this.varName = varName;
  }

  public async get(): Promise<string | null> {
    const value = readEnvironmentVariable(this.varName);
    return value ?? null;
  }
}
