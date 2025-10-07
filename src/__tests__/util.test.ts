/**
 * Tests for general utility functions
 */

import {
  defaultJsonEncoder,
  capitalizeFirstLetter,
  jsonDumps,
  extractId,
  maybeAwait,
  objectToBytes,
  decodeFameDataPayload,
  normalizePath,
  compiledPathPattern,
  secureDigest,
  urlsafeBase64Encode,
  camelToSnakeCase,
  snakeToCamelCase,
  isPlainObject,
  deepMerge,
  debounce,
  throttle,
  sleep,
  retryWithBackoff,
} from '../naylence/fame/util/util';

describe('Utility Functions', () => {
  describe('defaultJsonEncoder', () => {
    it('should encode Date objects to ISO string', () => {
      const date = new Date('2023-01-01T12:00:00.000Z');
      expect(defaultJsonEncoder(date)).toBe('2023-01-01T12:00:00Z');
    });

    it('should throw for unsupported types', () => {
      expect(() => defaultJsonEncoder(Symbol('test'))).toThrow(
        'Object of type symbol is not JSON serializable'
      );
    });
  });

  describe('capitalizeFirstLetter', () => {
    it('should capitalize first letter', () => {
      expect(capitalizeFirstLetter('hello')).toBe('Hello');
      expect(capitalizeFirstLetter('world')).toBe('World');
    });

    it('should handle empty string', () => {
      expect(capitalizeFirstLetter('')).toBe('');
    });

    it('should handle single character', () => {
      expect(capitalizeFirstLetter('a')).toBe('A');
    });

    it('should not change already capitalized', () => {
      expect(capitalizeFirstLetter('Hello')).toBe('Hello');
    });
  });

  describe('jsonDumps', () => {
    it('should pretty print JSON', () => {
      const obj = { name: 'test', value: 42 };
      const result = jsonDumps(obj);
      expect(result).toContain('{\n');
      expect(result).toContain('  "name": "test"');
      expect(result).toContain('  "value": 42');
    });

    it('should handle Date objects', () => {
      const obj = { date: new Date('2023-01-01T12:00:00.000Z') };
      const result = jsonDumps(obj);
      expect(result).toContain('"date": "2023-01-01T12:00:00.000Z"');
    });
  });

  describe('extractId', () => {
    it('should extract id from object', () => {
      expect(extractId({ id: 'test123' })).toBe('test123');
      expect(extractId({ id: 42, name: 'test' })).toBe(42);
    });

    it('should return null for objects without id', () => {
      expect(extractId({ name: 'test' })).toBeNull();
      expect(extractId({})).toBeNull();
    });

    it('should return null for non-objects', () => {
      expect(extractId('string')).toBeNull();
      expect(extractId(null)).toBeNull();
      expect(extractId(undefined)).toBeNull();
      expect(extractId(42)).toBeNull();
    });
  });

  describe('maybeAwait', () => {
    it('should await Promise values', async () => {
      const promise = Promise.resolve('result');
      const result = await maybeAwait(promise);
      expect(result).toBe('result');
    });

    it('should return non-Promise values directly', async () => {
      const result = await maybeAwait('direct');
      expect(result).toBe('direct');
    });

    it('should handle rejected promises', async () => {
      const promise = Promise.reject(new Error('test error'));
      await expect(maybeAwait(promise)).rejects.toThrow('test error');
    });
  });

  describe('objectToBytes', () => {
    it('should convert object to UTF-8 bytes', () => {
      const obj = { name: 'test' };
      const bytes = objectToBytes(obj);
      expect(bytes).toBeInstanceOf(Uint8Array);

      const decoded = new TextDecoder().decode(bytes);
      expect(JSON.parse(decoded)).toEqual(obj);
    });

    it('should handle unicode characters', () => {
      const obj = { emoji: '🚀', chinese: '你好' };
      const bytes = objectToBytes(obj);
      const decoded = new TextDecoder().decode(bytes);
      expect(JSON.parse(decoded)).toEqual(obj);
    });
  });

  describe('decodeFameDataPayload', () => {
    it('should decode base64 payload', () => {
      const base64 = btoa('hello world');
      const frame = { codec: 'b64', payload: base64 };
      const result = decodeFameDataPayload(frame);

      expect(result).toBeInstanceOf(Uint8Array);
      const decoded = new TextDecoder().decode(result);
      expect(decoded).toBe('hello world');
    });

    it('should return payload as-is for non-b64 codec', () => {
      const frame = { codec: 'json', payload: { test: 'data' } };
      const result = decodeFameDataPayload(frame);
      expect(result).toEqual({ test: 'data' });
    });

    it('should return payload as-is when no codec', () => {
      const frame = { payload: 'plain text' };
      const result = decodeFameDataPayload(frame);
      expect(result).toBe('plain text');
    });
  });

  describe('normalizePath', () => {
    it('should remove leading slashes', () => {
      expect(normalizePath('/path/to/file')).toBe('path/to/file');
      expect(normalizePath('//multiple/slashes')).toBe('multiple/slashes');
      expect(normalizePath('///path')).toBe('path');
    });

    it('should leave paths without leading slashes unchanged', () => {
      expect(normalizePath('path/to/file')).toBe('path/to/file');
      expect(normalizePath('file.txt')).toBe('file.txt');
    });

    it('should handle empty string', () => {
      expect(normalizePath('')).toBe('');
    });
  });

  describe('compiledPathPattern', () => {
    it('should compile wildcard patterns', () => {
      const pattern = compiledPathPattern('*.txt');
      expect(pattern.test('file.txt')).toBe(true);
      expect(pattern.test('document.txt')).toBe(true);
      expect(pattern.test('file.pdf')).toBe(false);
    });

    it('should handle question mark wildcards', () => {
      const pattern = compiledPathPattern('file?.txt');
      expect(pattern.test('file1.txt')).toBe(true);
      expect(pattern.test('fileA.txt')).toBe(true);
      expect(pattern.test('file12.txt')).toBe(false);
    });

    it('should cache compiled patterns', () => {
      const pattern1 = compiledPathPattern('*.js');
      const pattern2 = compiledPathPattern('*.js');
      expect(pattern1).toBe(pattern2); // Same instance due to caching
    });
  });

  describe('secureDigest', () => {
    it('should generate consistent digests', () => {
      const digest1 = secureDigest('test string');
      const digest2 = secureDigest('test string');
      expect(digest1).toBe(digest2);
    });

    it('should generate different digests for different inputs', () => {
      const digest1 = secureDigest('string1');
      const digest2 = secureDigest('string2');
      expect(digest1).not.toBe(digest2);
    });

    it('should generate base62 strings', () => {
      const digest = secureDigest('test');
      expect(digest).toMatch(/^[0-9a-zA-Z]+$/);
    });

    it('should handle different bit lengths', () => {
      const digest64 = secureDigest('test', 64);
      const digest128 = secureDigest('test', 128);
      expect(digest64.length).toBeLessThan(digest128.length);
    });
  });

  describe('urlsafeBase64Encode', () => {
    it('should encode data to URL-safe base64', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const result = urlsafeBase64Encode(data);
      expect(result).toBe('SGVsbG8');
    });

    it('should replace unsafe characters', () => {
      const data = new Uint8Array([255, 254, 253]); // Will contain + and /
      const result = urlsafeBase64Encode(data);
      expect(result).not.toContain('+');
      expect(result).not.toContain('/');
      expect(result).not.toContain('=');
    });
  });

  describe('camelToSnakeCase', () => {
    it('should convert CamelCase to snake_case', () => {
      expect(camelToSnakeCase('CamelCase')).toBe('camel_case');
      expect(camelToSnakeCase('XMLHttpRequest')).toBe('xml_http_request');
      expect(camelToSnakeCase('iPhone')).toBe('i_phone');
    });

    it('should handle already snake_case', () => {
      expect(camelToSnakeCase('snake_case')).toBe('snake_case');
    });

    it('should handle single words', () => {
      expect(camelToSnakeCase('word')).toBe('word');
      expect(camelToSnakeCase('Word')).toBe('word');
    });
  });

  describe('snakeToCamelCase', () => {
    it('should convert snake_case to camelCase', () => {
      expect(snakeToCamelCase('snake_case')).toBe('snakeCase');
      expect(snakeToCamelCase('some_long_name')).toBe('someLongName');
    });

    it('should handle already camelCase', () => {
      expect(snakeToCamelCase('camelCase')).toBe('camelCase');
    });

    it('should handle single words', () => {
      expect(snakeToCamelCase('word')).toBe('word');
    });
  });

  describe('isPlainObject', () => {
    it('should identify plain objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    it('should reject non-plain objects', () => {
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject('string')).toBe(false);
      expect(isPlainObject(42)).toBe(false);
    });
  });

  describe('deepMerge', () => {
    it('should merge shallow objects', () => {
      const target = { a: 1, b: 2 };
      const source = { b: 3, c: 4 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should merge nested objects', () => {
      const target = { a: { x: 1, y: 2 }, b: 3 };
      const source: any = { a: { y: 4, z: 5 } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { x: 1, y: 4, z: 5 }, b: 3 });
    });

    it('should not mutate original objects', () => {
      const target = { a: { x: 1 } };
      const source: any = { a: { y: 2 } };
      const result = deepMerge(target, source);
      expect(target).toEqual({ a: { x: 1 } });
      expect(result).toEqual({ a: { x: 1, y: 2 } });
    });
  });

  describe('debounce', () => {
    jest.useFakeTimers();

    afterEach(() => {
      jest.clearAllTimers();
    });

    it('should debounce function calls', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced();
      debounced();

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should pass arguments to debounced function', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced('arg1', 'arg2');
      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });

  describe('throttle', () => {
    jest.useFakeTimers();

    afterEach(() => {
      jest.clearAllTimers();
    });

    it('should throttle function calls', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 100);

      // First call should execute immediately
      throttled();
      expect(fn).toHaveBeenCalledTimes(1);

      // Subsequent calls within wait period should be throttled
      throttled();
      throttled();
      expect(fn).toHaveBeenCalledTimes(1);

      // Advance time to allow throttled call to execute
      jest.advanceTimersByTime(150);
      expect(fn).toHaveBeenCalledTimes(2); // One more call from throttling
    });
  });

  describe('sleep', () => {
    jest.useFakeTimers();

    afterEach(() => {
      jest.clearAllTimers();
    });

    it('should resolve after specified time', async () => {
      const promise = sleep(1000);
      jest.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('retryWithBackoff', () => {
    jest.useFakeTimers();

    afterEach(() => {
      jest.clearAllTimers();
      jest.clearAllMocks();
    });

    it('should succeed on first try', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail1'))
        .mockRejectedValueOnce(new Error('fail2'))
        .mockResolvedValueOnce('success');

      // Use real timers for this test
      jest.useRealTimers();

      const result = await retryWithBackoff(fn, 3, 10); // Use small delay
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);

      // Restore fake timers
      jest.useFakeTimers();
    }, 10000);

    it('should throw after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('persistent failure'));

      // Use real timers for this test
      jest.useRealTimers();

      await expect(retryWithBackoff(fn, 2, 10)).rejects.toThrow(
        'persistent failure'
      ); // Use small delay
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries

      // Restore fake timers
      jest.useFakeTimers();
    }, 10000);
  });
});
