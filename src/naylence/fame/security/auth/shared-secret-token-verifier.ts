import { createAuthorizationContext } from "naylence-core";
import type { AuthorizationContext } from "naylence-core";

import { credentialToString, type CredentialProvider } from "../credential/credential-provider.js";
import type { TokenVerifier } from "./token-verifier.js";

export interface SharedSecretTokenVerifierOptions {
  credentialProvider: CredentialProvider;
  principal?: string;
}

export class SharedSecretTokenVerifier implements TokenVerifier {
  private readonly credentialProvider: CredentialProvider;
  private readonly principal: string;

  constructor(options: SharedSecretTokenVerifierOptions) {
    this.credentialProvider = options.credentialProvider;
    this.principal = options.principal ?? "*";
  }

  public async verify(
    token: string,
    options?: { expectedAudience?: string }
  ): Promise<AuthorizationContext> {
    const expectedSecret = credentialToString(await this.credentialProvider.get());
    if (!expectedSecret) {
      throw new Error("Shared secret credential provider returned empty value");
    }

    if (token !== expectedSecret) {
      throw new Error("Invalid shared secret token");
    }

    const claims: Record<string, unknown> = {
      sub: this.principal,
      mode: "shared-secret",
      valid: true,
    };

    if (options?.expectedAudience) {
      claims.aud = options.expectedAudience;
    }

    return createAuthorizationContext({
      authenticated: true,
      authorized: true,
      principal: this.principal,
      claims,
      authMethod: "shared_secret",
    });
  }
}
