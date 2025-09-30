import type { CredentialProvider } from "./credential-provider.js";

export class NoneCredentialProvider implements CredentialProvider {
  public async get(): Promise<Uint8Array | string | null> {
    return null;
  }
}
