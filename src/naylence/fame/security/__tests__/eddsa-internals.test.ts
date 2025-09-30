import * as ed25519 from "@noble/ed25519";
import { SigningMaterial } from "naylence-core";
import type { FameEnvelope } from "naylence-core";
import { secureDigest, urlsafeBase64Encode } from "../../util/util.js";
import {
  canonicalJson,
  decodeBase64Url,
  frameDigest,
  immutableHeaders,
  removeNullFields,
} from "../signing/eddsa-signer-verifier.js";
import {
  decodePem,
  encodeUtf8,
  parseEd25519PrivateKey,
  readStringProperty,
} from "../signing/eddsa-utils.js";
import { EdDSAEnvelopeSigner } from "../signing/eddsa-envelope-signer.js";
import { EdDSAEnvelopeSignerFactory } from "../signing/eddsa-envelope-signer-factory.js";
import { EdDSAEnvelopeVerifier } from "../signing/eddsa-envelope-verifier.js";
import { EdDSAEnvelopeVerifierFactory } from "../signing/eddsa-envelope-verifier-factory.js";
import { SigningConfig } from "../signing/signing-config.js";
import type { CryptoProvider } from "../crypto/providers/crypto-provider.js";
import type { KeyProvider } from "../keys/key-provider.js";
import type { KeyRecord } from "../keys/key-store.js";

const { sync, utils: edUtils } = ed25519;

const PRIVATE_KEY_BYTES = Uint8Array.from(
  Buffer.from("8f6c9a4b2d5e7f0182736455aa99bbccddee00112233445566778899aabbccdd", "hex")
);
const PRIVATE_KEY_PEM = (() => {
  const body = Buffer.from(PRIVATE_KEY_BYTES).toString("base64");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
})();
const PUBLIC_KEY_BYTES = sync.getPublicKey(PRIVATE_KEY_BYTES);
const PUBLIC_KEY_B64 = urlsafeBase64Encode(PUBLIC_KEY_BYTES);

const globalDefaults = globalThis as Record<string, unknown>;
const defaultAtob =
  typeof globalDefaults.atob === "function"
    ? (globalDefaults.atob as (value: string) => string)
    : (value: string) => Buffer.from(value, "base64").toString("binary");
const defaultBtoa =
  typeof globalDefaults.btoa === "function"
    ? (globalDefaults.btoa as (value: string) => string)
    : (value: string) => Buffer.from(value, "binary").toString("base64");
globalDefaults.atob = defaultAtob;
globalDefaults.btoa = defaultBtoa;

class StubKeyProvider implements KeyProvider {
  public constructor(private readonly keys: Record<string, KeyRecord>) {}

  public async getKey(kid: string): Promise<KeyRecord> {
    const hit = this.keys[kid];
    if (!hit) {
      throw new Error(`missing key ${kid}`);
    }
    return hit;
  }

  public async getKeysForPath(_physicalPath: string): Promise<Iterable<KeyRecord>> {
    return [];
  }
}

describe("eddsa utility helpers", () => {
  afterEach(() => {
    const globalAny = globalThis as Record<string, unknown>;
    globalAny.atob = defaultAtob;
    globalAny.btoa = defaultBtoa;
    globalAny.Buffer = Buffer;
    globalAny.TextEncoder = TextEncoder;
  });

  it("reads the first available string property", () => {
    const source = { primary: "value", secondary: "other" };
    const globalAny = globalThis as Record<string, unknown>;
    delete globalAny.atob;
    delete globalAny.btoa;
    const result = readStringProperty(source, "missing", "secondary", "primary");
    expect(result).toBe("other");
  });

  it("returns undefined when no string properties exist", () => {
    const result = readStringProperty({ count: 3 }, "primary");
    expect(result).toBeUndefined();
  });

  it("ignores empty and non-string property candidates", () => {
    const result = readStringProperty(
      { empty: "", number: 42, text: "ok" },
      "empty",
      "number",
      "text"
    );
    expect(result).toBe("ok");
  });

  it("decodes PEM data via Buffer fallback", () => {
    const globalAny = globalThis as Record<string, unknown>;
    delete globalAny.atob;
    const pem = "-----BEGIN TEST-----\nAQID\n-----END TEST-----";
    const decoded = decodePem(pem);
    expect(Array.from(decoded)).toEqual([1, 2, 3]);
  });

  it("decodes PEM when atob is available", () => {
    const globalAny = globalThis as Record<string, unknown>;
    globalAny.atob = (input: string) => Buffer.from(input, "base64").toString("binary");
    const pem = "-----BEGIN KEY-----\nBAUG\n-----END KEY-----";
    const decoded = decodePem(pem);
    expect(Array.from(decoded)).toEqual([4, 5, 6]);
  });

  it("parses raw and PKCS#8 Ed25519 private keys", () => {
    const rawPem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(PRIVATE_KEY_BYTES).toString("base64") +
      "\n-----END PRIVATE KEY-----";
    const raw = parseEd25519PrivateKey(rawPem);
    expect(raw).toHaveLength(32);
    expect(Buffer.from(raw).equals(Buffer.from(PRIVATE_KEY_BYTES))).toBe(true);

    const pkcs8Pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      "MC4CAQAwBQYDK2VwBCIEIGZK9w7pp2k1l67KObZ8X6P0S6wj0VmoY6x5D2BdYmrd\n" +
      "-----END PRIVATE KEY-----";
    const pkcs8 = parseEd25519PrivateKey(pkcs8Pem);
    expect(pkcs8).toHaveLength(32);
  });

  it("rejects malformed Ed25519 private key structures", () => {
    const badPem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    expect(() => parseEd25519PrivateKey(badPem)).toThrow("Unexpected ASN.1 tag");
  });

  it("rejects unsupported PKCS#8 Ed25519 layouts", () => {
    const invalidStructure = new Uint8Array([
      0x30,
      0x2e,
      0x02,
      0x01,
      0x00,
      0x30,
      0x05,
      0x06,
      0x03,
      0x2b,
      0x65,
      0x70,
      0x04,
      0x22,
      0x05,
      0x20,
      ...Array.from({ length: 32 }, (_, index) => index + 1),
    ]);
    const invalidPem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(invalidStructure).toString("base64") +
      "\n-----END PRIVATE KEY-----";

    expect(() => parseEd25519PrivateKey(invalidPem)).toThrow(
      "Unsupported Ed25519 private key structure"
    );
  });

  it("rejects ASN.1 structures that end before declaring a length", () => {
    const shortPem = "-----BEGIN PRIVATE KEY-----\nMA==\n-----END PRIVATE KEY-----";
    expect(() => parseEd25519PrivateKey(shortPem)).toThrow("Unexpected end of ASN.1 data");
  });

  it("rejects ASN.1 length encodings with zero length-of-length octets", () => {
    const bytes = Uint8Array.from([0x30, 0x80]);
    const pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(bytes).toString("base64") +
      "\n-----END PRIVATE KEY-----";
    expect(() => parseEd25519PrivateKey(pem)).toThrow("Unsupported ASN.1 length encoding");
  });

  it("rejects ASN.1 length encodings when long-form octets truncate early", () => {
    const bytes = Uint8Array.from([0x30, 0x82, 0x01]);
    const pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(bytes).toString("base64") +
      "\n-----END PRIVATE KEY-----";
    expect(() => parseEd25519PrivateKey(pem)).toThrow("Unexpected end of ASN.1 data");
  });

  it("rejects ASN.1 length encodings with excessive length octets", () => {
    const bytes = Uint8Array.from([0x30, 0x85, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(bytes).toString("base64") +
      "\n-----END PRIVATE KEY-----";
    expect(() => parseEd25519PrivateKey(pem)).toThrow("Unsupported ASN.1 length encoding");
  });

  it("rejects PKCS#8 Ed25519 payloads with unexpected lengths", () => {
    const validPkcs8 = "MC4CAQAwBQYDK2VwBCIEIGZK9w7pp2k1l67KObZ8X6P0S6wj0VmoY6x5D2BdYmrd";
    const mutated = Uint8Array.from(Buffer.from(validPkcs8, "base64"));
    mutated[15] = 0x10; // inner OCTET STRING length should be 0x20 (32)
    const invalidPem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(mutated).toString("base64") +
      "\n-----END PRIVATE KEY-----";

    expect(() => parseEd25519PrivateKey(invalidPem)).toThrow(
      "Unexpected Ed25519 private key length"
    );
  });

  it("encodes UTF-8 with and without TextEncoder support", async () => {
    const encoded = encodeUtf8("hello ✓");
    expect(Array.from(encoded)).toEqual(Array.from(Buffer.from("hello ✓", "utf8")));

    const globalAny = globalThis as Record<string, unknown>;
    const previousTextEncoder = globalAny.TextEncoder;
    globalAny.TextEncoder = undefined;

    jest.resetModules();
    const { encodeUtf8: fallbackEncodeUtf8 } = await import("../signing/eddsa-utils.js");
    const fallback = fallbackEncodeUtf8("fallback");
    expect(Array.from(fallback)).toEqual(Array.from(Buffer.from("fallback", "utf8")));
    jest.resetModules();

    globalAny.TextEncoder = previousTextEncoder;
  });

  it("canonicalizes complex objects and preserves deterministic JSON", () => {
    const entries: Array<[string, unknown]> = [
      ["k", new Uint8Array([1, 2, 3])],
      ["j", { value: 42 }],
    ];
    const canonicalMap = new Map<string, unknown>(entries);
    const original = {
      z: 1,
      nested: { b: 2, a: new Date("2025-01-01T00:00:00Z") },
      list: new Set(["b", "a"]),
      map: canonicalMap,
      binary: new Uint8Array([4, 5]),
      array: [1, null, 2],
    };

    const json = canonicalJson(original);
    expect(JSON.parse(json)).toEqual({
      array: [1, null, 2],
      binary: "BAU",
      list: ["a", "b"],
      map: { j: { value: 42 }, k: "AQID" },
      nested: { a: "2025-01-01T00:00:00.000Z", b: 2 },
      z: 1,
    });

    const cleaned = removeNullFields({
      keep: "value",
      nested: { skip: null, inner: ["x", null, "y"] },
    });
    expect(cleaned).toEqual({ keep: "value", nested: { inner: ["x", "y"] } });
  });

  it("serializes wrapper objects, symbols, and functions using defined fallbacks", () => {
    class Wrapper {
      public constructor(public readonly value: unknown) {}
    }

    const symbol = Symbol("wrapped");
    const json = canonicalJson({ wrapper: new Wrapper("inner"), symbol, fn: () => "noop" });
    const parsed = JSON.parse(json);
    expect(parsed.wrapper).toBe("inner");
    expect(parsed.symbol).toBe(String(symbol));
    expect(typeof parsed.fn).toBe("string");
  });

  it("computes frame digests for data and non-data frames", () => {
    const dataFrameDigest = frameDigest({
      type: "Data",
      payload: { foo: "bar" },
    } as unknown as FameEnvelope["frame"]);

    const otherDigest = frameDigest({ type: "Ack", pd: null } as unknown as FameEnvelope["frame"]);

    expect(typeof dataFrameDigest).toBe("string");
    expect(typeof otherDigest).toBe("string");
    expect(dataFrameDigest).not.toEqual(otherDigest);
  });

  it("extracts immutable headers with normalized routing values", () => {
    const envelope = {
      version: "1",
      id: "env-1",
      sid: "sid",
      traceId: 123,
      to: { value: "dest" },
      replyTo: { value: "reply" },
      capabilities: ["a"],
      corrId: null,
    } as unknown as FameEnvelope;

    expect(immutableHeaders(envelope)).toEqual({
      version: "1",
      id: "env-1",
      sid: "sid",
      trace_id: 123,
      to: "[object Object]",
      reply_to: "[object Object]",
      capabilities: ["a"],
      corr_id: null,
    });
  });

  it("decodes base64url strings using both atob and Buffer paths", () => {
    const original = Uint8Array.from([9, 8, 7, 6]);
    const base64 = urlsafeBase64Encode(original);
    expect(Array.from(decodeBase64Url(base64))).toEqual(Array.from(original));

    const globalAny = globalThis as Record<string, unknown>;
    const previousAtob = globalAny.atob;
    globalAny.atob = undefined;
    const decoded = decodeBase64Url(base64);
    expect(Array.from(decoded)).toEqual(Array.from(original));
    globalAny.atob = previousAtob;
  });

  it("throws when no base64url decoder is available", () => {
    const original = Uint8Array.from([1, 2, 3, 4]);
    const base64 = urlsafeBase64Encode(original);

    const globalAny = globalThis as Record<string, unknown>;
    const previousAtob = globalAny.atob;
    const previousBuffer = globalAny.Buffer;
    globalAny.atob = undefined;
    globalAny.Buffer = undefined;

    expect(() => decodeBase64Url(base64)).toThrow(
      "No base64 decoder available in this environment"
    );

    globalAny.atob = previousAtob;
    globalAny.Buffer = previousBuffer;
  });

  it("encodes binary values using btoa when Buffer is unavailable", () => {
    const globalAny = globalThis as Record<string, unknown>;
    const previousBtoa = globalAny.btoa;
    const previousBuffer = globalAny.Buffer;
    globalAny.btoa = () => "3q0=";
    globalAny.Buffer = undefined;

    const json = canonicalJson({ data: new Uint8Array([0xde, 0xad]) });
    expect(json).toContain("3q0");

    globalAny.btoa = previousBtoa;
    globalAny.Buffer = previousBuffer;
  });

  it("throws when binary encoding support is unavailable", () => {
    const globalAny = globalThis as Record<string, unknown>;
    const previousBtoa = globalAny.btoa;
    const previousBuffer = globalAny.Buffer;
    globalAny.btoa = undefined;
    globalAny.Buffer = undefined;

    expect(() => canonicalJson({ payload: new Uint8Array([1, 2, 3]) })).toThrow(
      "No base64 encoder available in this environment"
    );

    globalAny.btoa = previousBtoa;
    globalAny.Buffer = previousBuffer;
  });

  it("throws when PEM decoding support is unavailable", () => {
    const globalAny = globalThis as Record<string, unknown>;
    const previousAtob = globalAny.atob;
    const previousBuffer = globalAny.Buffer;
    globalAny.atob = undefined;
    globalAny.Buffer = undefined;

    expect(() => decodePem("-----BEGIN KEY-----\nAA==\n-----END KEY-----")).toThrow(
      "Base64 decoding is not available in this environment"
    );

    globalAny.atob = previousAtob;
    globalAny.Buffer = previousBuffer;
  });

  it("throws when UTF-8 encoding support is unavailable", async () => {
    const globalAny = globalThis as Record<string, unknown>;
    const previousTextEncoder = globalAny.TextEncoder;
    const previousBuffer = globalAny.Buffer;
    globalAny.TextEncoder = undefined;
    globalAny.Buffer = undefined;

    jest.resetModules();
    const { encodeUtf8: fallbackEncodeUtf8 } = await import("../signing/eddsa-utils.js");
    expect(() => fallbackEncodeUtf8("utf8?")).toThrow(
      "No UTF-8 encoder available in this environment"
    );
    jest.resetModules();

    globalAny.TextEncoder = previousTextEncoder;
    globalAny.Buffer = previousBuffer;
  });

  it("canonicalizes array buffers and typed arrays consistently", () => {
    const buffer = new ArrayBuffer(4);
    const view = new Uint16Array(buffer);
    view[0] = 0x1234;
    view[1] = 0x5678;

    const payload = {
      buffer,
      view,
      dataView: new DataView(buffer),
    };

    const json = canonicalJson(payload);
    const parsed = JSON.parse(json);
    expect(parsed.buffer).toEqual(parsed.view);
    expect(parsed.dataView).toEqual(parsed.view);
  });

  it("provides SHA-512 sync hashing for single and multiple chunks", () => {
    const chunk = encodeUtf8("message");
    expect(edUtils.sha512Sync).toBeDefined();
    const digestSingle = edUtils.sha512Sync!(chunk);
    const digestMulti = edUtils.sha512Sync!(chunk, chunk);
    expect(digestSingle).toHaveLength(64);
    expect(digestMulti).toHaveLength(64);
  });
});

function buildEnvelope(): FameEnvelope {
  return {
    version: "1",
    id: "env-1",
    sid: "node-1",
    frame: {
      type: "Data",
      payload: { value: "hello" },
    },
    sec: {},
  } as unknown as FameEnvelope;
}

function buildKeyProvider(physicalPath: string): KeyProvider {
  const sid = secureDigest(physicalPath);
  const jwk: KeyRecord = {
    kid: "kid-1",
    use: "sig",
    kty: "OKP",
    crv: "Ed25519",
    x: PUBLIC_KEY_B64,
    sid,
  } as KeyRecord;
  return new StubKeyProvider({ "kid-1": jwk });
}

describe("EdDSA envelope signer and verifier integration", () => {
  it("signs envelopes, fills payload digest, and verifies successfully", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };

    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = buildEnvelope();
    const physicalPath = "/phys/path";

    const signed = signer.signEnvelope(envelope, { physicalPath });
    expect(signed.frame).toHaveProperty("pd");
    expect(signed.sec?.sig?.kid).toBe("kid-1");
    expect(typeof signed.sec?.sig?.val).toBe("string");

    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider(physicalPath));
    await expect(verifier.verifyEnvelope(signed)).resolves.toBe(true);
  });

  it("throws when envelope lacks a signature header", async () => {
    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/missing-sig"));
    await expect(
      verifier.verifyEnvelope({ ...buildEnvelope(), sec: {} } as FameEnvelope)
    ).rejects.toThrow("Missing envelope.sec.sig header");
  });

  it("throws when signature header fields are malformed", async () => {
    const signer = new EdDSAEnvelopeSigner({
      cryptoProvider: {
        signingPrivatePem: PRIVATE_KEY_PEM,
        signatureKeyId: "kid-1",
      },
    });
    const signed = signer.signEnvelope(buildEnvelope(), { physicalPath: "/malformed" });

    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/malformed"));

    const missingKid = {
      ...signed,
      sec: { sig: { ...signed.sec?.sig, kid: "" } },
    } as FameEnvelope;
    await expect(verifier.verifyEnvelope(missingKid)).rejects.toThrow(
      "Signature header missing 'kid'"
    );

    const missingVal = {
      ...signed,
      sec: { sig: { ...signed.sec?.sig, val: "" } },
    } as FameEnvelope;
    await expect(verifier.verifyEnvelope(missingVal)).rejects.toThrow(
      "Signature header missing 'val'"
    );
  });

  it("throws when key provider returns null for unknown key id", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/unknown-key" });

    const provider: KeyProvider = {
      async getKey() {
        return null as unknown as KeyRecord;
      },
      async getKeysForPath() {
        return [];
      },
    };

    const verifier = new EdDSAEnvelopeVerifier(provider);
    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow("Unknown key id: kid-1");
  });

  it("throws when DataFrame payload digest is missing", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/missing-pd" });
    (envelope.frame as { pd?: string | null }).pd = null;

    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/missing-pd"));
    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow(
      "DataFrame missing payload digest (pd field)"
    );
  });

  it("throws when payload digest mismatches after tampering", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/tamper" });

    (envelope.frame as { payload?: unknown }).payload = { tampered: true };

    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/tamper"));
    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Payload digest mismatch in DataFrame"
    );
  });

  it("throws when signature verification fails despite correct length", async () => {
    const verifySpy = jest.spyOn(ed25519, "verify").mockResolvedValue(false);

    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const signed = signer.signEnvelope(buildEnvelope(), { physicalPath: "/invalid-signature" });

    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/invalid-signature"));
    await expect(verifier.verifyEnvelope(signed)).rejects.toThrow(
      "Envelope signature verification failed"
    );

    verifySpy.mockRestore();
  });

  it("throws when signing key metadata omits sid", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const signed = signer.signEnvelope(buildEnvelope(), { physicalPath: "/missing-sid" });

    const provider: KeyProvider = {
      async getKey() {
        return {
          kid: "kid-1",
          use: "sig",
          kty: "OKP",
          crv: "Ed25519",
          x: PUBLIC_KEY_B64,
        } as KeyRecord;
      },
      async getKeysForPath() {
        return [];
      },
    };

    const verifier = new EdDSAEnvelopeVerifier(provider);
    await expect(verifier.verifyEnvelope(signed)).rejects.toThrow("Signing key missing sid");
  });

  it("throws when JWK lacks usable public key material", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const signed = signer.signEnvelope(buildEnvelope(), { physicalPath: "/missing-public" });

    const provider: KeyProvider = {
      async getKey() {
        return {
          kid: "kid-1",
          use: "sig",
          kty: "OKP",
          crv: "Ed25519",
          x: 123,
          sid: secureDigest("/missing-public"),
        } as unknown as KeyRecord;
      },
      async getKeysForPath() {
        return [];
      },
    };

    const verifier = new EdDSAEnvelopeVerifier(provider);
    await expect(verifier.verifyEnvelope(signed)).rejects.toThrow(
      "JWK missing public key material"
    );
  });

  it("verifies non-data frames using canonical digest", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = buildEnvelope();
    envelope.frame = { type: "Ack", pd: null } as unknown as FameEnvelope["frame"];

    const signed = signer.signEnvelope(envelope, { physicalPath: "/ack" });
    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/ack"));
    await expect(verifier.verifyEnvelope(signed)).resolves.toBe(true);
  });

  it("supports explicit key overrides and certificate-based kid resolution", () => {
    const certProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      nodeJwk: () => ({ kid: "cert-kid", x5c: ["cert"] }),
    };

    const signer = new EdDSAEnvelopeSigner({
      cryptoProvider: certProvider,
      signingConfig: new SigningConfig({ signingMaterial: SigningMaterial.X509_CHAIN }),
      keyId: "explicit-kid",
    });

    const envelope = buildEnvelope();
    const signed = signer.signEnvelope(envelope, { physicalPath: "x" });
    expect(signed.sec?.sig?.kid).toBe("explicit-kid");

    const fallbackSigner = new EdDSAEnvelopeSigner({
      cryptoProvider: certProvider,
      signingConfig: new SigningConfig({ signingMaterial: SigningMaterial.X509_CHAIN }),
      privateKeyPem: PRIVATE_KEY_PEM,
    });
    const fallbackSigned = fallbackSigner.signEnvelope(buildEnvelope(), { physicalPath: "y" });
    expect(fallbackSigned.sec?.sig?.kid).toBe("cert-kid");
  });

  it("throws when crypto provider or key identifiers are missing", () => {
    expect(() => new EdDSAEnvelopeSigner()).toThrow("No crypto provider is configured for signing");

    const incompleteProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider: incompleteProvider });
    expect(() => signer.signEnvelope(buildEnvelope(), { physicalPath: "z" })).toThrow(
      "Crypto provider does not expose a signature key id"
    );
  });

  it("throws when envelope is missing sid", () => {
    const signer = new EdDSAEnvelopeSigner({
      cryptoProvider: {
        signingPrivatePem: PRIVATE_KEY_PEM,
        signatureKeyId: "kid-1",
      },
    });

    const envelope = buildEnvelope();
    delete (envelope as Record<string, unknown>).sid;

    expect(() => signer.signEnvelope(envelope, { physicalPath: "/sidless" })).toThrow(
      "Envelope missing sid"
    );
  });

  it("preserves existing payload digest values on data frames", () => {
    const signer = new EdDSAEnvelopeSigner({
      cryptoProvider: {
        signingPrivatePem: PRIVATE_KEY_PEM,
        signatureKeyId: "kid-1",
      },
    });

    const envelope = buildEnvelope();
    const dataFrame = envelope.frame as { type: string; payload?: unknown; pd?: string | null };
    dataFrame.pd = "precomputed-digest";

    const signed = signer.signEnvelope(envelope, { physicalPath: "/existing-pd" });
    expect((signed.frame as { pd?: string | null }).pd).toBe("precomputed-digest");
  });

  it("throws when crypto provider omits the signing private key", () => {
    const signer = new EdDSAEnvelopeSigner({
      cryptoProvider: {
        signatureKeyId: "kid-1",
      },
    });

    expect(() => signer.signEnvelope(buildEnvelope(), { physicalPath: "/no-key" })).toThrow(
      "Crypto provider does not expose a signing private key"
    );
  });

  it("registers a sha512Sync fallback when noble utils omit it", async () => {
    const utilsRecord = edUtils as { sha512Sync?: typeof edUtils.sha512Sync };
    const originalSha512 = utilsRecord.sha512Sync;
    utilsRecord.sha512Sync = undefined;

    jest.resetModules();
    await import("../signing/eddsa-envelope-signer.js");
    jest.resetModules();

    expect(typeof utilsRecord.sha512Sync).toBe("function");
    utilsRecord.sha512Sync = originalSha512;
  });

  it("validates payload digests and logical checking branches", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const physicalPath = "/phys/path/check";
    const envelope = buildEnvelope();
    const signed = signer.signEnvelope(envelope, { physicalPath });

    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider(physicalPath));
    await expect(verifier.verifyEnvelope(signed, { checkPayload: true })).resolves.toBe(true);

    const relaxedFrame = {
      type: "Data",
      payload: "trusted",
      pd: (signed.frame as { pd?: string | null }).pd,
    } as const;
    const relaxedEnvelope = {
      ...signed,
      frame: relaxedFrame as unknown as FameEnvelope["frame"],
    } as FameEnvelope;
    await expect(verifier.verifyEnvelope(relaxedEnvelope, { checkPayload: false })).resolves.toBe(
      true
    );
  });

  it("rejects signatures with structural issues", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/path" });
    const verifier = new EdDSAEnvelopeVerifier(buildKeyProvider("/path"));

    const tamperedLength = {
      ...envelope,
      sec: { sig: { ...envelope.sec?.sig, val: "AAE" } },
    } as FameEnvelope;
    await expect(verifier.verifyEnvelope(tamperedLength)).rejects.toThrow(
      "Signature must be 64 bytes for Ed25519"
    );

    const shortKeyProvider = new StubKeyProvider({
      "kid-1": {
        kid: "kid-1",
        use: "sig",
        kty: "OKP",
        crv: "Ed25519",
        x: urlsafeBase64Encode(PUBLIC_KEY_BYTES.slice(0, 30)),
        sid: secureDigest("/path"),
      } as KeyRecord,
    });
    const shortKeyVerifier = new EdDSAEnvelopeVerifier(shortKeyProvider);
    await expect(shortKeyVerifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Ed25519 public key must be 32 bytes"
    );
  });

  it("handles certificate-based keys according to signing policy", async () => {
    const jwkWithCert: KeyRecord = {
      kid: "kid-cert",
      use: "sig",
      kty: "OKP",
      crv: "Ed25519",
      x: PUBLIC_KEY_B64,
      x5c: ["cert"],
      sid: secureDigest("/cert"),
    } as KeyRecord;

    const provider = new StubKeyProvider({ "kid-cert": jwkWithCert });
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-cert",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/cert" });

    const strictVerifier = new EdDSAEnvelopeVerifier(provider);
    await expect(strictVerifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Certificate keys are disabled by signing policy"
    );

    const relaxedVerifier = new EdDSAEnvelopeVerifier(provider, {
      signingConfig: new SigningConfig({ signingMaterial: SigningMaterial.X509_CHAIN }),
    });
    await expect(relaxedVerifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Certificate-based Ed25519 verification is not implemented in the TypeScript runtime yet"
    );
  });

  it("propagates key validation feedback from the verifier", async () => {
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-1",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/invalid" });

    const provider = new (class implements KeyProvider {
      public async getKey(kid: string): Promise<KeyRecord> {
        return {
          kid,
          use: "enc",
          kty: "OKP",
          crv: "X25519",
          x: PUBLIC_KEY_B64,
          sid: secureDigest("/invalid"),
        } as KeyRecord;
      }

      public async getKeysForPath(_physicalPath: string): Promise<Iterable<KeyRecord>> {
        return [];
      }
    })();

    const verifier = new EdDSAEnvelopeVerifier(provider);
    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Key kid-1 is not valid for signing"
    );
    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow("use=enc");
  });
});

describe("EdDSA factories", () => {
  it("creates signer instances and respects override options", async () => {
    const factory = new EdDSAEnvelopeSignerFactory();
    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-override",
    };

    const signer = await factory.create(null, {
      cryptoProvider,
      privateKeyPem: PRIVATE_KEY_PEM,
      keyId: "factory-kid",
    });

    const envelope = {
      version: "1",
      id: "env-2",
      sid: "node-2",
      frame: { type: "Data", payload: "" },
      sec: {},
    } as unknown as FameEnvelope;

    const signed = (signer as EdDSAEnvelopeSigner).signEnvelope(envelope, {
      physicalPath: "/factory",
    });
    expect(signed.sec?.sig?.kid).toBe("factory-kid");
  });

  it("uses the crypto provider supplied via options", async () => {
    const factory = new EdDSAEnvelopeSignerFactory();
    const optionProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "option-kid",
    };
    const signer = await factory.create(null, {
      cryptoProvider: optionProvider,
    });

    const envelope = buildEnvelope();
    const signed = (signer as EdDSAEnvelopeSigner).signEnvelope(envelope, {
      physicalPath: "/factory-option",
    });
    expect(signed.sec?.sig?.kid).toBe("option-kid");
  });

  it("throws when no crypto provider is supplied to the factory", async () => {
    const factory = new EdDSAEnvelopeSignerFactory();
    await expect(factory.create()).rejects.toThrow("No crypto provider is configured for signing");
  });

  it("requires a key provider for verifier factory", async () => {
    const factory = new EdDSAEnvelopeVerifierFactory();
    await expect(factory.create()).rejects.toThrow(
      "EdDSAEnvelopeVerifierFactory requires a key provider"
    );

    const keyProvider = new StubKeyProvider({
      "kid-1": {
        kid: "kid-1",
        use: "sig",
        kty: "OKP",
        crv: "Ed25519",
        x: PUBLIC_KEY_B64,
        sid: secureDigest("/vf"),
      } as KeyRecord,
    });

    const verifier = await factory.create(null, keyProvider, null, {
      signingConfig: new SigningConfig({ signingMaterial: SigningMaterial.RAW_KEY }),
    });
    const { EdDSAEnvelopeVerifier: DynamicVerifier } = await import(
      "../signing/eddsa-envelope-verifier.js"
    );
    expect(verifier).toBeInstanceOf(DynamicVerifier);
  });

  it("propagates signingConfig argument to verifier instances", async () => {
    const factory = new EdDSAEnvelopeVerifierFactory();
    const certificateProvider = new StubKeyProvider({
      "kid-cert": {
        kid: "kid-cert",
        use: "sig",
        kty: "OKP",
        crv: "Ed25519",
        x: PUBLIC_KEY_B64,
        x5c: ["cert"],
        sid: secureDigest("/factory-cert"),
      } as KeyRecord,
    });

    const verifier = (await factory.create(
      null,
      certificateProvider,
      new SigningConfig({ signingMaterial: SigningMaterial.X509_CHAIN })
    )) as EdDSAEnvelopeVerifier;

    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-cert",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/factory-cert" });

    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Certificate-based Ed25519 verification is not implemented in the TypeScript runtime yet"
    );
  });

  it("allows options signingConfig to override argument defaults", async () => {
    const factory = new EdDSAEnvelopeVerifierFactory();
    const certificateProvider = new StubKeyProvider({
      "kid-cert": {
        kid: "kid-cert",
        use: "sig",
        kty: "OKP",
        crv: "Ed25519",
        x: PUBLIC_KEY_B64,
        x5c: ["cert"],
        sid: secureDigest("/factory-cert-option"),
      } as KeyRecord,
    });

    const verifier = (await factory.create(null, certificateProvider, new SigningConfig(), {
      signingConfig: new SigningConfig({ signingMaterial: SigningMaterial.X509_CHAIN }),
    })) as EdDSAEnvelopeVerifier;

    const cryptoProvider: CryptoProvider = {
      signingPrivatePem: PRIVATE_KEY_PEM,
      signatureKeyId: "kid-cert",
    };
    const signer = new EdDSAEnvelopeSigner({ cryptoProvider });
    const envelope = signer.signEnvelope(buildEnvelope(), { physicalPath: "/factory-cert-option" });

    await expect(verifier.verifyEnvelope(envelope)).rejects.toThrow(
      "Certificate-based Ed25519 verification is not implemented in the TypeScript runtime yet"
    );
  });
});
