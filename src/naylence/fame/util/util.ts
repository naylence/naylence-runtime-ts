/**
 * General utility functions for JSON handling, string manipulation,
 * path normalization, base64 encoding, hashing, and more.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { color, AnsiColor, formatTimestamp } from "./formatter.js";

export const ENV_VAR_SHOW_ENVELOPES = "FAME_SHOW_ENVELOPES";

export function isEnvelopeLoggingEnabled(): boolean {
  return typeof process !== "undefined" && process.env?.[ENV_VAR_SHOW_ENVELOPES] === "true";
}

export const showEnvelopes = isEnvelopeLoggingEnabled();

export function formatTimestampForConsole(): string {
  return color(formatTimestamp(), AnsiColor.GRAY);
}

export function prettyModel(value: unknown): string {
  try {
    return jsonDumps(value);
  } catch (error) {
    return String(error);
  }
}

/**
 * Default JSON encoder for non-standard types.
 */
export function defaultJsonEncoder(obj: any): any {
  if (obj instanceof Date) {
    return obj.toISOString().replace(/\.\d{3}Z$/, "Z"); // Remove milliseconds for Python compatibility
  }
  throw new TypeError(`Object of type ${typeof obj} is not JSON serializable`);
}

/**
 * Capitalize the first letter of a string.
 */
export function capitalizeFirstLetter(text: string): string {
  if (!text) {
    return text;
  }
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * Convert a value to pretty-printed JSON string.
 */
export function jsonDumps(value: any): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      try {
        return defaultJsonEncoder(val);
      } catch {
        return val;
      }
    },
    2
  );
}

/**
 * Extract an ID from an object (either from object property or 'id' key).
 */
export function extractId(obj: any): string | null {
  if (typeof obj === "object" && obj !== null) {
    if ("id" in obj) {
      return obj.id;
    }
  }
  return null;
}

/**
 * Maybe await a value that could be a Promise or regular value.
 */
export async function maybeAwait<T>(valueOrPromise: T | Promise<T>): Promise<T> {
  if (valueOrPromise instanceof Promise) {
    return await valueOrPromise;
  }
  return valueOrPromise;
}

/**
 * Convert an object to JSON bytes.
 */
export function objectToBytes(obj: any): Uint8Array {
  const jsonString = JSON.stringify(obj);
  return new TextEncoder().encode(jsonString);
}

/**
 * Decode Fame data payload based on codec.
 */
export function decodeFameDataPayload(frame: { codec?: string; payload: any }): any {
  if (frame.codec === "b64") {
    // Decode base64 to bytes
    const base64 = frame.payload;
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }
  return frame.payload;
}

/**
 * Normalize a path by removing leading slashes.
 */
export function normalizePath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Cache for compiled path patterns.
 */
const pathPatternCache = new Map<string, RegExp>();

/**
 * Translate a shell-style wildcard pattern into a compiled regex
 * and cache the result for speed.
 */
export function compiledPathPattern(pattern: string): RegExp {
  let compiled = pathPatternCache.get(pattern);
  if (!compiled) {
    // Convert shell wildcard to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
      .replace(/\*/g, ".*") // * becomes .*
      .replace(/\?/g, "."); // ? becomes .
    compiled = new RegExp(`^${regexPattern}$`);

    // Limit cache size to prevent memory leaks
    if (pathPatternCache.size > 256) {
      pathPatternCache.clear();
    }
    pathPatternCache.set(pattern, compiled);
  }
  return compiled;
}

// Base62 characters: 0–9, a–z, A–Z
const BASE62_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE62_BASE = BigInt(BASE62_CHARS.length);

/**
 * Convert a number to base62 string.
 */
function toBase62(num: bigint): string {
  if (num === 0n) {
    return BASE62_CHARS[0];
  }

  const result: string[] = [];
  let value = num;
  while (value > 0n) {
    const remainder = value % BASE62_BASE;
    result.push(BASE62_CHARS[Number(remainder)]);
    value = value / BASE62_BASE;
  }

  return result.reverse().join("");
}

/**
 * Create a secure digest of a string.
 * @param s Input string
 * @param bits Number of bits to include in digest (default: 128)
 * @returns Base62-encoded digest
 */
export function secureDigest(s: string, bits: number = 128): string {
  try {
    const digest = sha256(new TextEncoder().encode(s));
    const desiredBytes = Math.min(digest.length, Math.max(1, Math.ceil(bits / 8)));
    let value = 0n;
    for (let i = 0; i < desiredBytes; i += 1) {
      value = (value << 8n) | BigInt(digest[i]);
    }

    return toBase62(value);
  } catch {
    // Fallback for environments without TextEncoder support
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) {
      const char = s.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return toBase62(BigInt(Math.abs(hash)));
  }
}

/**
 * URL-safe base64 encode (without padding).
 */
export function urlsafeBase64Encode(data: Uint8Array): string {
  // Convert Uint8Array to string for btoa
  let binaryString = "";
  for (let i = 0; i < data.length; i++) {
    binaryString += String.fromCharCode(data[i]);
  }

  return btoa(binaryString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function urlsafeBase64Decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  if (typeof atob === "function") {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(padded, "base64"));
  }

  throw new Error("Base64 decoding is not available in this environment");
}

/**
 * Convert CamelCase string to snake_case.
 */
export function camelToSnakeCase(name: string): string {
  // Insert underscore before uppercase letters that follow lowercase letters or digits
  let result = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  // Insert underscore before uppercase letters that are followed by lowercase letters
  result = result.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2");
  return result.toLowerCase();
}

/**
 * Convert snake_case string to CamelCase.
 */
export function snakeToCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Check if a value is a plain object (not an array, Date, etc.).
 */
export function isPlainObject(value: any): value is Record<string, any> {
  return (
    typeof value === "object" &&
    value !== null &&
    value.constructor === Object &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Deep merge two objects.
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
        result[key] = deepMerge(targetValue, sourceValue as any);
      } else {
        result[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

/**
 * Create a debounced version of a function.
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | number | undefined;

  return function (this: any, ...args: Parameters<T>) {
    const later = () => {
      timeout = undefined;
      func.apply(this, args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Create a throttled version of a function.
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | number | undefined;
  let previous = 0;

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now();
    const remaining = wait - (now - previous);

    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      previous = now;
      func.apply(this, args);
    } else if (!timeout) {
      timeout = setTimeout(() => {
        previous = Date.now();
        timeout = undefined;
        func.apply(this, args);
      }, remaining);
    }
  };
}

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  maxDelay: number = 10000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      await sleep(delay);
    }
  }

  throw lastError!;
}
