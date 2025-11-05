import { beforeEach, describe, expect, it } from 'vitest';
import {
  BrowserWrappedKeyCredentialProvider,
  hasCryptoSupport,
} from '@naylence/runtime';

const DB_NAME = 'naylence-secrets';
const PASSPHRASE = 'vitest-browser-secret';

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);

    request.onerror = () => {
      reject(request.error ?? new Error('Failed to delete IndexedDB database'));
    };

    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
}

describe('browser crypto surface', () => {
  beforeEach(async () => {
    const factory = globalThis.indexedDB;
    if (!factory) return;
    await deleteDatabase(factory, DB_NAME).catch(() => undefined);
  });

  it('detects WebCrypto availability', () => {
    expect(hasCryptoSupport()).toBe(true);
    expect(globalThis.crypto?.subtle).toBeDefined();
  });

  it('supports WebCrypto primitives', async () => {
    const cryptoObject = globalThis.crypto;
    expect(cryptoObject?.subtle).toBeDefined();

    const keyPair = await cryptoObject!.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveBits', 'deriveKey']
    );

    expect(keyPair.privateKey).toBeDefined();
    expect(keyPair.publicKey).toBeDefined();

    const buffer = cryptoObject!.getRandomValues(new Uint8Array(32));
    expect(buffer.byteLength).toBe(32);
  });

  it('wraps and unwraps master keys with PBKDF2 + AES-GCM', async () => {
    const idbFactory = globalThis.indexedDB;
    if (!idbFactory) throw new Error('IndexedDB is required for this test');

    const createProvider = () =>
      new BrowserWrappedKeyCredentialProvider({
        promptPassphrase: async () => PASSPHRASE,
        idbFactory,
      });

    const first = createProvider();
    const stored = await first.get();
    expect(stored.byteLength).toBe(32);

    const second = createProvider();
    const roundTripped = await second.get();
    expect(roundTripped).toEqual(stored);
  });
});
