import type { KeyLike } from 'jose';
import type { JoseModule } from '../../auth/jose-loader.js';
import { DevKeyPair } from './dev-key-pair.js';

export async function buildDevKeyPair(
  jose: JoseModule,
  keyPair: { publicKey: KeyLike | CryptoKey; privateKey: KeyLike | CryptoKey },
  kid: string,
  jwkFields: Record<string, unknown>
): Promise<DevKeyPair> {
  const privatePem = await jose.exportPKCS8(keyPair.privateKey);
  const publicPem = await jose.exportSPKI(keyPair.publicKey);
  const jwk = await jose.exportJWK(keyPair.publicKey);

  const jwkRecord: Record<string, unknown> = {
    ...jwk,
    ...jwkFields,
    kid,
  };

  return {
    privatePem,
    publicPem,
    jwks: {
      keys: [jwkRecord],
    },
  };
}
