import type { CredentialProvider } from '../credential/credential-provider.js';
import type { Token } from './token.js';
import type { TokenProvider } from './token-provider.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE_MS = ONE_DAY_MS * 365 * 100;

export class SharedSecretTokenProvider implements TokenProvider {
  constructor(private readonly credentialProvider: CredentialProvider) {}

  public async getToken(): Promise<Token> {
    const value = (await this.credentialProvider.get()) ?? '';
    return {
      value,
      expiresAt: Date.now() + FAR_FUTURE_MS,
    };
  }
}
