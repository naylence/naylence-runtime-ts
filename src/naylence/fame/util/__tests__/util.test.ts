import { jsonDumps, withLegacySnakeCaseKeys } from '../util.js';

describe('jsonDumps', () => {
  it('serializes circular references safely', () => {
    const obj: Record<string, unknown> = { name: 'cycle' };
    obj['self'] = obj;

    const serialized = jsonDumps(obj);

    expect(serialized).toContain('"self": "[Circular]"');
  });

  it('serializes bigint values as strings', () => {
    const payload = { value: BigInt(42) };

    const serialized = jsonDumps(payload);

    expect(serialized).toContain('"value": "42"');
  });
});

describe('withLegacySnakeCaseKeys', () => {
  it('adds snake_case aliases for camelCase keys', () => {
    const result = withLegacySnakeCaseKeys({ maxConcurrent: 3 });

    expect(result.maxConcurrent).toBe(3);
    expect(result.max_concurrent).toBe(3);
  });

  it('adds camelCase aliases for snake_case keys', () => {
    const result = withLegacySnakeCaseKeys({ max_concurrent: 5 });

    expect(result.max_concurrent).toBe(5);
    expect(result.maxConcurrent).toBe(5);
  });

  it('respects existing aliases without overriding values', () => {
    const result = withLegacySnakeCaseKeys({
      maxConcurrent: 7,
      max_concurrent: 9,
    });

    expect(result.maxConcurrent).toBe(7);
    expect(result.max_concurrent).toBe(9);
  });
});
