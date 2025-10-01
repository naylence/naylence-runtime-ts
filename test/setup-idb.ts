import { indexedDB } from "fake-indexeddb";
import "fake-indexeddb/auto";

if (typeof globalThis.indexedDB === "undefined") {
  Object.defineProperty(globalThis, "indexedDB", {
    value: indexedDB,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}
