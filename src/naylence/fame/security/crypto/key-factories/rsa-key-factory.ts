import { requireCryptoSupport } from '../crypto-dependencies.js';
import { requireJose } from '../../auth/jose-loader.js';
import { DevKeyPair } from './dev-key-pair.js';
import { buildDevKeyPair } from './key-factory-utils.js';

export async function createRsaKeypair(kid = 'dev'): Promise<DevKeyPair> {
  requireCryptoSupport();
  const jose = await requireJose();
  const keyPair = await jose.generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  return buildDevKeyPair(jose, keyPair, kid, { alg: 'RS256', use: 'sig' });
}
