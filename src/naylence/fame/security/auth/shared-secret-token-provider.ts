import {
  credentialToString,
  type CredentialProvider,
} from '../credential/credential-provider.js';
import type { Token } from './token.js';
import type { TokenProvider } from './token-provider.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE_MS = ONE_DAY_MS * 365 * 100;

export class SharedSecretTokenProvider implements TokenProvider {
  private readonly credentialProvider: CredentialProvider;

  constructor(
    options:
      | CredentialProvider
      | { credentialProvider: CredentialProvider }
      | { credential_provider: CredentialProvider }
      | Record<string, unknown>
  ) {
    let credentialProvider: CredentialProvider | undefined;

    if (
      options &&
      typeof options === 'object' &&
      'credentialProvider' in options
    ) {
      credentialProvider = (options as { credentialProvider: CredentialProvider }).credentialProvider;
    } else if (
      options &&
      typeof options === 'object' &&
      'credential_provider' in options
    ) {
      credentialProvider = (options as { credential_provider: CredentialProvider }).credential_provider;
    }

    if (!credentialProvider) {
      if (
        options &&
        typeof options === 'object' &&
        'get' in options &&
        typeof (options as CredentialProvider).get === 'function'
      ) {
        credentialProvider = options as CredentialProvider;
      } else {
        throw new Error(
          'SharedSecretTokenProvider requires a credentialProvider option'
        );
      }
    }

    this.credentialProvider = credentialProvider;
  }

  public async getToken(): Promise<Token> {
    const rawValue = await this.credentialProvider.get();
    const value = credentialToString(rawValue) ?? '';
    return {
      value,
      expiresAt: Date.now() + FAR_FUTURE_MS,
    };
  }
}
