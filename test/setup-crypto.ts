import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "util";

if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: false,
    enumerable: false,
    configurable: true,
  });
} else if (!globalThis.crypto && webcrypto) {
  (globalThis as any).crypto = webcrypto as unknown as Crypto;
}

if (typeof (globalThis as any).TextEncoder === "undefined") {
  (globalThis as any).TextEncoder = TextEncoder;
}

if (typeof (globalThis as any).TextDecoder === "undefined") {
  (globalThis as any).TextDecoder = TextDecoder;
}
