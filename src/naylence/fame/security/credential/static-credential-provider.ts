import type { CredentialProvider } from './credential-provider.js';

export class StaticCredentialProvider implements CredentialProvider {
  private readonly credentialValue: string;

  constructor(credentialValue: string) {
    this.credentialValue = credentialValue;
  }

  public async get(): Promise<Uint8Array | string | null> {
    return this.credentialValue;
  }
}
