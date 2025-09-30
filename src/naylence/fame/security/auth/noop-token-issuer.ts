import type { TokenIssuer } from "./token-issuer.js";

export class NoopTokenIssuer implements TokenIssuer {
  public readonly issuer = "";

  public async issue(_claims: Record<string, unknown>): Promise<string> {
    return "";
  }
}
