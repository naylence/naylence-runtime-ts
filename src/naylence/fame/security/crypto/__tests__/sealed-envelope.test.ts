import { randomBytes } from "@noble/hashes/utils";
import { x25519 } from "@noble/curves/ed25519";

import {
  SEALED_ENVELOPE_NONCE_LENGTH,
  SEALED_ENVELOPE_OVERHEAD,
  SEALED_ENVELOPE_PUBLIC_KEY_LENGTH,
  SEALED_ENVELOPE_TAG_LENGTH,
  parseSealedEnvelope,
  sealedDecrypt,
  sealedEncrypt,
} from "../sealed-envelope.js";

const TEST_MESSAGE = new TextEncoder().encode("overlay security test payload");

function createKeyPair() {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.scalarMultBase(privateKey);
  return { privateKey, publicKey };
}

describe("sealed envelope crypto helpers", () => {
  test("round-trip encrypt/decrypt succeeds", () => {
    const { privateKey, publicKey } = createKeyPair();

    const sealed = sealedEncrypt(TEST_MESSAGE, publicKey);
    expect(sealed.length).toBe(TEST_MESSAGE.length + SEALED_ENVELOPE_OVERHEAD);

    const decrypted = sealedDecrypt(sealed, privateKey);
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(TEST_MESSAGE));
  });

  test("decryption fails with wrong private key", () => {
    const recipient = createKeyPair();
    const attacker = createKeyPair();
    const sealed = sealedEncrypt(TEST_MESSAGE, recipient.publicKey);

    expect(() => sealedDecrypt(sealed, attacker.privateKey)).toThrow(
      "Failed to decrypt sealed envelope"
    );
  });

  test("encryption output structure matches expectations", () => {
    const { publicKey } = createKeyPair();
    const sealed = sealedEncrypt(TEST_MESSAGE, publicKey);

    const ephPub = sealed.subarray(0, SEALED_ENVELOPE_PUBLIC_KEY_LENGTH);
    const nonce = sealed.subarray(
      SEALED_ENVELOPE_PUBLIC_KEY_LENGTH,
      SEALED_ENVELOPE_PUBLIC_KEY_LENGTH + SEALED_ENVELOPE_NONCE_LENGTH
    );
    const ciphertext = sealed.subarray(
      SEALED_ENVELOPE_PUBLIC_KEY_LENGTH + SEALED_ENVELOPE_NONCE_LENGTH
    );

    expect(ephPub.length).toBe(SEALED_ENVELOPE_PUBLIC_KEY_LENGTH);
    expect(nonce.length).toBe(SEALED_ENVELOPE_NONCE_LENGTH);
    expect(ciphertext.length).toBe(TEST_MESSAGE.length + SEALED_ENVELOPE_TAG_LENGTH);
  });

  test("rejects malformed sealed blob inputs", () => {
    const { privateKey } = createKeyPair();
    const shortBlob = randomBytes(SEALED_ENVELOPE_OVERHEAD - 1);

    expect(() => sealedDecrypt(shortBlob, privateKey)).toThrow("Sealed blob is too short");
  });

  test("tampering with ciphertext causes decryption failure", () => {
    const { privateKey, publicKey } = createKeyPair();
    const sealed = sealedEncrypt(TEST_MESSAGE, publicKey);
    const tampered = sealed.slice();

    tampered[tampered.length - 1] ^= 0xff;

    expect(() => sealedDecrypt(tampered, privateKey)).toThrow("Failed to decrypt sealed envelope");
  });

  test("parseSealedEnvelope exposes envelope components", () => {
    const { publicKey } = createKeyPair();
    const sealed = sealedEncrypt(TEST_MESSAGE, publicKey);
    const parsed = parseSealedEnvelope(sealed);

    expect(parsed.ephemeralPublicKey.length).toBe(SEALED_ENVELOPE_PUBLIC_KEY_LENGTH);
    expect(parsed.nonce.length).toBe(SEALED_ENVELOPE_NONCE_LENGTH);
    expect(parsed.ciphertext.length).toBe(TEST_MESSAGE.length + SEALED_ENVELOPE_TAG_LENGTH);
  });
});
