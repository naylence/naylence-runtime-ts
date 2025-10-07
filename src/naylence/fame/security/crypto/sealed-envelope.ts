import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const HKDF_INFO = utf8ToBytes('naylence-sealed-envelope');
const SYMMETRIC_KEY_LENGTH = 32;
const PUBLIC_KEY_LENGTH = 32;
const PRIVATE_KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function toUint8Array(
  value: Uint8Array | ArrayBuffer | ArrayBufferView
): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new TypeError('Expected Uint8Array, ArrayBuffer, or ArrayBufferView');
}

function deriveSymmetricKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, undefined, HKDF_INFO, SYMMETRIC_KEY_LENGTH);
}

function assertKeyLength(
  key: Uint8Array,
  expected: number,
  label: string
): void {
  if (key.length !== expected) {
    throw new Error(
      `${label} must be ${expected} bytes, received ${key.length}`
    );
  }
}

export function sealedEncrypt(
  plaintext: Uint8Array | ArrayBuffer | ArrayBufferView,
  recipientPublicKey: Uint8Array | ArrayBuffer | ArrayBufferView
): Uint8Array {
  const message = toUint8Array(plaintext);
  const publicKey = toUint8Array(recipientPublicKey);
  assertKeyLength(publicKey, PUBLIC_KEY_LENGTH, 'Recipient public key');

  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.scalarMultBase(ephemeralPrivateKey);
  const sharedSecret = x25519.scalarMult(ephemeralPrivateKey, publicKey);
  const symmetricKey = deriveSymmetricKey(sharedSecret);
  const nonce = randomBytes(NONCE_LENGTH);

  try {
    const aead = chacha20poly1305(symmetricKey, nonce);
    const ciphertext = aead.encrypt(message);
    return concatBytes(ephemeralPublicKey, nonce, ciphertext);
  } finally {
    ephemeralPrivateKey.fill(0);
    sharedSecret.fill(0);
    symmetricKey.fill(0);
  }
}

export function sealedDecrypt(
  sealedBlob: Uint8Array | ArrayBuffer | ArrayBufferView,
  recipientPrivateKey: Uint8Array | ArrayBuffer | ArrayBufferView
): Uint8Array {
  const blob = toUint8Array(sealedBlob);
  const privateKey = toUint8Array(recipientPrivateKey);
  assertKeyLength(privateKey, PRIVATE_KEY_LENGTH, 'Recipient private key');

  const minimumLength = PUBLIC_KEY_LENGTH + NONCE_LENGTH + TAG_LENGTH;
  if (blob.length < minimumLength) {
    throw new Error(
      `Sealed blob is too short; expected at least ${minimumLength} bytes, received ${blob.length}`
    );
  }

  const ephemeralPublicKey = blob.subarray(0, PUBLIC_KEY_LENGTH);
  const nonce = blob.subarray(
    PUBLIC_KEY_LENGTH,
    PUBLIC_KEY_LENGTH + NONCE_LENGTH
  );
  const ciphertext = blob.subarray(PUBLIC_KEY_LENGTH + NONCE_LENGTH);

  const sharedSecret = x25519.scalarMult(privateKey, ephemeralPublicKey);
  const symmetricKey = deriveSymmetricKey(sharedSecret);

  try {
    const aead = chacha20poly1305(symmetricKey, nonce);
    return aead.decrypt(ciphertext);
  } catch (error) {
    throw new Error(
      `Failed to decrypt sealed envelope${error instanceof Error && error.message ? `: ${error.message}` : ''}`
    );
  } finally {
    sharedSecret.fill(0);
    symmetricKey.fill(0);
  }
}

export function parseSealedEnvelope(
  sealedBlob: Uint8Array | ArrayBuffer | ArrayBufferView
): {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  const blob = toUint8Array(sealedBlob);
  const minimumLength = PUBLIC_KEY_LENGTH + NONCE_LENGTH + TAG_LENGTH;
  if (blob.length < minimumLength) {
    throw new Error(
      `Sealed blob is too short; expected at least ${minimumLength} bytes, received ${blob.length}`
    );
  }

  return {
    ephemeralPublicKey: blob.subarray(0, PUBLIC_KEY_LENGTH),
    nonce: blob.subarray(PUBLIC_KEY_LENGTH, PUBLIC_KEY_LENGTH + NONCE_LENGTH),
    ciphertext: blob.subarray(PUBLIC_KEY_LENGTH + NONCE_LENGTH),
  };
}

export const SEALED_ENVELOPE_PUBLIC_KEY_LENGTH = PUBLIC_KEY_LENGTH;
export const SEALED_ENVELOPE_PRIVATE_KEY_LENGTH = PRIVATE_KEY_LENGTH;
export const SEALED_ENVELOPE_NONCE_LENGTH = NONCE_LENGTH;
export const SEALED_ENVELOPE_TAG_LENGTH = TAG_LENGTH;
export const SEALED_ENVELOPE_OVERHEAD =
  PUBLIC_KEY_LENGTH + NONCE_LENGTH + TAG_LENGTH;
