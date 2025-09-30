function hasBuffer(): boolean {
  return typeof Buffer !== "undefined";
}

export function readStringProperty(source: unknown, ...names: string[]): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  for (const name of names) {
    const value = (source as Record<string, unknown>)[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

export function decodePem(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");

  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (hasBuffer()) {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  throw new Error("Base64 decoding is not available in this environment");
}

interface Asn1Element {
  length: number;
  contentOffset: number;
  nextOffset: number;
}

function readLength(data: Uint8Array, offset: number): { length: number; nextOffset: number } {
  const initial = data[offset];
  if (initial === undefined) {
    throw new Error("Unexpected end of ASN.1 data");
  }

  if ((initial & 0x80) === 0) {
    return { length: initial, nextOffset: offset + 1 };
  }

  const lengthOfLength = initial & 0x7f;
  if (lengthOfLength === 0 || lengthOfLength > 4) {
    throw new Error("Unsupported ASN.1 length encoding");
  }

  let length = 0;
  let position = offset + 1;
  for (let i = 0; i < lengthOfLength; i += 1) {
    const byte = data[position];
    if (byte === undefined) {
      throw new Error("Unexpected end of ASN.1 data");
    }
    length = (length << 8) | byte;
    position += 1;
  }

  return { length, nextOffset: position };
}

function readElement(data: Uint8Array, offset: number, tag: number): Asn1Element {
  if (data[offset] !== tag) {
    throw new Error(
      `Unexpected ASN.1 tag: expected 0x${tag.toString(16)}, got 0x${(data[offset] ?? 0).toString(16)}`
    );
  }

  const { length, nextOffset } = readLength(data, offset + 1);
  const contentOffset = nextOffset;
  return {
    length,
    contentOffset,
    nextOffset: contentOffset + length,
  };
}

export function parseEd25519PrivateKey(pem: string): Uint8Array {
  const raw = decodePem(pem);

  if (raw.length === 32) {
    return raw.slice();
  }

  // Handle PKCS#8 structure defined in RFC 8410
  const sequence = readElement(raw, 0, 0x30);
  const version = readElement(raw, sequence.contentOffset, 0x02);
  let offset = version.nextOffset;

  const algorithm = readElement(raw, offset, 0x30);
  offset = algorithm.nextOffset;

  const privateKey = readElement(raw, offset, 0x04);
  const privateContent = raw.subarray(
    privateKey.contentOffset,
    privateKey.contentOffset + privateKey.length
  );

  if (privateContent.length === 32) {
    return privateContent.slice();
  }

  if (privateContent.length >= 34 && privateContent[0] === 0x04) {
    const innerLength = privateContent[1];
    if (innerLength !== 32 || privateContent.length < innerLength + 2) {
      throw new Error("Unexpected Ed25519 private key length");
    }
    return privateContent.subarray(2, 34);
  }

  throw new Error("Unsupported Ed25519 private key structure");
}

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;

export function encodeUtf8(value: string): Uint8Array {
  if (textEncoder) {
    return textEncoder.encode(value);
  }

  if (hasBuffer()) {
    return Uint8Array.from(Buffer.from(value, "utf8"));
  }

  throw new Error("No UTF-8 encoder available in this environment");
}
