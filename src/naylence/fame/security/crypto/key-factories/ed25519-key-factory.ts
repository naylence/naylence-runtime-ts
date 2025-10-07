import { requireCryptoSupport } from '../crypto-dependencies.js';
import { requireJose } from '../../auth/jose-loader.js';
import { DevKeyPair } from './dev-key-pair.js';
import { buildDevKeyPair } from './key-factory-utils.js';

export async function createEd25519Keypair(kid = 'dev'): Promise<DevKeyPair> {
  requireCryptoSupport();
  const jose = await requireJose();
  const keyPair = await jose.generateKeyPair('Ed25519', { extractable: true });
  return buildDevKeyPair(jose, keyPair, kid, { alg: 'EdDSA', use: 'sig' });
}
