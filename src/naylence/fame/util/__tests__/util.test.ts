import { jsonDumps } from '../util.js';

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
