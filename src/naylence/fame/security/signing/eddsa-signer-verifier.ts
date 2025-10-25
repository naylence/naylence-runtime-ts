import type { AllFramesUnion, DataFrame, FameEnvelope } from '@naylence/core';
import { secureDigest } from '../../util/util.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function arrayBufferFrom(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  );
}

function encodeBinary(value: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < value.length; i += 1) {
    binary += String.fromCharCode(value[i]);
  }

  if (typeof btoa === 'function') {
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  throw new Error('No base64 encoder available in this environment');
}

export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);

  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(padded, 'base64'));
  }

  throw new Error('No base64 decoder available in this environment');
}

function toSerializable(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    return encodeBinary(arrayBufferFrom(value));
  }

  if (value instanceof ArrayBuffer) {
    return encodeBinary(new Uint8Array(value));
  }

  if (value instanceof Map) {
    const entries: Record<string, unknown> = {};
    for (const [key, entryValue] of value.entries()) {
      entries[String(key)] = toSerializable(entryValue);
    }
    return entries;
  }

  if (value instanceof Set) {
    return Array.from(value.values())
      .map((item) => toSerializable(item))
      .sort();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      const serialized = toSerializable(entryValue);
      if (serialized !== undefined) {
        result[key] = serialized;
      }
    }
    return result;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'value' in (value as Record<string, unknown>)
  ) {
    return toSerializable((value as Record<string, unknown>).value);
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }

  return value;
}

function canonicalize(value: unknown): unknown {
  const serializable = toSerializable(value);

  if (Array.isArray(serializable)) {
    return serializable.map((item) => canonicalize(item));
  }

  if (isPlainObject(serializable)) {
    const entries = Object.entries(serializable)
      .map(([key, entryValue]) => [key, canonicalize(entryValue)] as const)
      .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));

    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      result[key] = entryValue;
    }
    return result;
  }

  return serializable;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function removeNullFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => removeNullFields(item)) as unknown as T;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue === null || entryValue === undefined) {
        continue;
      }
      result[key] = removeNullFields(entryValue);
    }
    return result as T;
  }

  return value;
}

function isDataFrame(frame: AllFramesUnion): frame is DataFrame {
  return (frame as DataFrame).type === 'Data';
}

export function frameDigest(frame: AllFramesUnion): string {
  if (isDataFrame(frame)) {
    const payload = frame.payload ?? '';
    const payloadString = payload === '' ? '' : canonicalJson(payload);
    return secureDigest(payloadString);
  }

  const cleaned = removeNullFields(frame);
  const canonical = canonicalJson(cleaned);
  return secureDigest(canonical);
}

export function immutableHeaders(
  envelope: FameEnvelope
): Record<string, unknown> {
  return {
    version: envelope.version,
    id: envelope.id,
    sid: envelope.sid ?? null,
    trace_id: envelope.traceId ?? null,
    to: envelope.to ? String(envelope.to) : null,
    reply_to: envelope.replyTo ? String(envelope.replyTo) : null,
    capabilities: envelope.capabilities ?? null,
    corr_id: envelope.corrId ?? null,
  };
}
