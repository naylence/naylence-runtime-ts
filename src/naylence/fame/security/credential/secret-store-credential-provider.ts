import type { CredentialProvider } from './credential-provider.js';

export class SecretStoreCredentialProvider implements CredentialProvider {
  private readonly secretName: string;

  constructor(secretName: string) {
    if (!secretName) {
      throw new Error(
        'Secret store credential provider requires a secret name'
      );
    }
    this.secretName = secretName;
  }

  public async get(): Promise<Uint8Array | string | null> {
    void this.secretName;
    return null;
  }
}
