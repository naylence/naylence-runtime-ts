import type { TokenIssuer } from '../../auth/token-issuer.js';
import type { TokenVerifier } from '../../auth/token-verifier.js';

export interface CryptoProvider {
  signingPrivatePem?: string | null;
  signingPublicPem?: string | null;
  signatureKeyId?: string | null;
  encryptionPrivatePem?: string | null;
  encryptionPublicPem?: string | null;
  encryptionKeyId?: string | null;
  hmacSecret?: string | null;
  issuer?: string | null;
  audience?: string | null;
  getTokenIssuer?(): TokenIssuer | null | undefined;
  getTokenVerifier?(): TokenVerifier | null | undefined;
  prepareForAttach?(
    systemId: string,
    assignedPath: string | undefined,
    acceptedLogicals: string[]
  ): void;
  nodeJwk?(): Record<string, unknown> | null | undefined;
  getJwks?(): { keys?: Array<Record<string, unknown>> } | null | undefined;
}

let instance: CryptoProvider | null = null;

export function getCryptoProvider(): CryptoProvider | null {
  return instance;
}

export function setCryptoProvider(provider: CryptoProvider | null): void {
  instance = provider;
}
