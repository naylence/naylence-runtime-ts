import {
  KeyCorrelationMap,
  type KeyCorrelationMapOptions,
} from '../key-correlation-map.js';

describe('KeyCorrelationMap', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts snake_case ttl_sec alias for expiration handling', () => {
    const baseTime = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => baseTime);

    const map = new KeyCorrelationMap({
      ttl_sec: 1,
    } as unknown as KeyCorrelationMapOptions);

    map.add('corr-active', 'route-active');
    nowSpy.mockImplementation(() => baseTime + 500);
    expect(map.pop('corr-active')).toBe('route-active');

    map.add('corr-expired', 'route-expired');
    nowSpy.mockImplementation(() => baseTime + 2000);
    expect(map.pop('corr-expired')).toBeNull();
  });

  it('evicts using max_entries alias', () => {
    const baseTime = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => baseTime);

    const map = new KeyCorrelationMap({
      ttl_sec: 60,
      max_entries: 1,
    } as unknown as KeyCorrelationMapOptions);

    map.add('corr-1', 'route-1');
    map.add('corr-2', 'route-2');

    expect(map.size()).toBe(1);
    expect(map.pop('corr-1')).toBeNull();
    expect(map.pop('corr-2')).toBe('route-2');
  });
});
