import { parseAddressComponents } from 'naylence-core';
import {
  getFameRoot,
  isPoolLogical,
  matchesPoolLogical,
  validateLogicalSegment,
  validateLogical,
  logicalToHostname,
  hostnameToLogical,
  logicalsToHostnames,
  hostnamesToLogicals,
  validateHostLogical,
  validateHostLogicals,
  createLogicalUri,
  createHostLogicalUri,
  convertWildcardLogicalToDnsConstraint,
  logicalPatternsToDnsConstraints,
  matchesPoolAddress,
  extractPoolBase,
  extractPoolAddressBase,
  isPoolAddress,
} from '../logicals.js';

jest.mock('naylence-core', () => ({
  parseAddressComponents: jest.fn(),
}));

const parseAddressComponentsMock = parseAddressComponents as jest.MockedFunction<
  typeof parseAddressComponents
>;

const restoreEnvValue = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

describe('environment helpers', () => {
  const originalFameRoot = process.env.FAME_ROOT;

  afterEach(() => {
    restoreEnvValue('FAME_ROOT', originalFameRoot);
    parseAddressComponentsMock.mockReset();
  });

  it('returns default fame root when env missing', () => {
    delete process.env.FAME_ROOT;
    expect(getFameRoot()).toBe('fame.fabric');
  });

  it('returns fame root from env and handles missing process', () => {
    process.env.FAME_ROOT = 'custom.root';
    expect(getFameRoot()).toBe('custom.root');

    const originalProcess = (globalThis as any).process;
    try {
      (globalThis as any).process = undefined;
      expect(getFameRoot()).toBe('fame.fabric');
    } finally {
      (globalThis as any).process = originalProcess;
    }
  });
});

describe('pool logical helpers', () => {
  afterEach(() => {
    parseAddressComponentsMock.mockReset();
  });

  it('detects pool logical prefix', () => {
    expect(isPoolLogical('*.cluster')).toBe(true);
    expect(isPoolLogical('cluster')).toBe(false);
  });

  it('matches pool logical patterns', () => {
    expect(matchesPoolLogical('svc.a.example', '*.example')).toBe(true);
    expect(matchesPoolLogical('example', '*.example')).toBe(true);
    expect(matchesPoolLogical('svc.example', 'example')).toBe(false);
    expect(matchesPoolLogical('svc.example', '*.')).toBe(false);
  });

  it('extracts pool base only for wildcard host', () => {
    expect(extractPoolBase('*.example')).toBe('example');
    expect(extractPoolBase('example')).toBeNull();
  });
});

describe('logical segment validation', () => {
  it.each([
    [
      '',
      [false, 'Empty path segment'],
    ],
    [
      'a'.repeat(64),
      [false, "Path segment '" + 'a'.repeat(64) + "' exceeds 63 characters"],
    ],
    [
      'invalid!chars',
      [
        false,
        "Path segment 'invalid!chars' must contain only alphanumeric characters and hyphens",
      ],
    ],
    [
      '-start',
      [false, "Path segment '-start' cannot start or end with hyphen"],
    ],
    [
      'end-',
      [false, "Path segment 'end-' cannot start or end with hyphen"],
    ],
    [
      'double--dash',
      [false, "Path segment 'double--dash' cannot contain consecutive hyphens"],
    ],
  ])('rejects invalid segment %p', (segment, expected) => {
    expect(validateLogicalSegment(segment)).toEqual(expected);
  });

  it('accepts valid segment', () => {
    expect(validateLogicalSegment('valid-segment')).toEqual([true, null]);
  });
});

describe('logical validation', () => {
  const originalFameRoot = process.env.FAME_ROOT;

  afterEach(() => {
    restoreEnvValue('FAME_ROOT', originalFameRoot);
  });

  it('rejects empty or missing leading slash', () => {
    expect(validateLogical('')).toEqual([false, 'Empty logical']);
    expect(validateLogical('foo')).toEqual([
      false,
      "Logical 'foo' must start with '/'",
    ]);
  });

  it('validates root and empty segments', () => {
    expect(validateLogical('/')).toEqual([true, null]);
    expect(validateLogical('//')).toEqual([
      false,
      'Logical must contain at least one non-empty segment',
    ]);
  });

  it('propagates segment validation errors', () => {
    expect(validateLogical('/foo/-bad')).toEqual([
      false,
      "Invalid logical '/foo/-bad': Path segment '-bad' cannot start or end with hyphen",
    ]);
  });

  it('rejects hostname longer than DNS limit', () => {
    const longSegment = 'a'.repeat(63);
    const logical = `/${Array.from({ length: 5 }, () => longSegment).join('/')}`;
    expect(validateLogical(logical)).toEqual([
      false,
      `Logical '${logical}' converts to hostname exceeding 253 characters`,
    ]);
  });

  it('accepts valid logical', () => {
    expect(validateLogical('/foo/bar')).toEqual([true, null]);
  });
});

describe('logical hostname conversions', () => {
  const originalFameRoot = process.env.FAME_ROOT;

  afterEach(() => {
    restoreEnvValue('FAME_ROOT', originalFameRoot);
  });

  it('converts logicals to hostnames with error handling', () => {
    expect(() => logicalToHostname('')).toThrow('Empty logical');
    expect(() => logicalToHostname('foo')).toThrow(
      "Logical 'foo' cannot start without '/'",
    );

    process.env.FAME_ROOT = 'root.example';
    expect(logicalToHostname('/')).toBe('root.example');

    expect(logicalToHostname('/foo/bar')).toBe('bar.foo');
  });

  it('converts hostnames to logicals with validation', () => {
    expect(() => hostnameToLogical('')).toThrow('Empty hostname');

    process.env.FAME_ROOT = 'root.example';
    expect(hostnameToLogical('root.example')).toBe('/');

    expect(() => hostnameToLogical('foo..bar')).toThrow(
      "Invalid hostname 'foo..bar' contains empty segments",
    );

    expect(hostnameToLogical('bar.foo')).toBe('/foo/bar');
  });

  it('translates arrays between logicals and hostnames', () => {
    expect(logicalsToHostnames(['/a/b', '/c'])).toEqual(['b.a', 'c']);
    expect(hostnamesToLogicals(['b.a', 'c'])).toEqual(['/a/b', '/c']);
  });
});

describe('host logical validation', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    restoreEnvValue('NODE_ENV', originalNodeEnv);
  });

  it('validates wildcard host logicals', () => {
    expect(validateHostLogical('*.example.com')).toEqual([true, null]);
    expect(validateHostLogical('sub.*.example.com')).toEqual([
      false,
      "Host logical 'sub.*.example.com' contains wildcard not in leftmost position",
    ]);
    expect(validateHostLogical('*.')).toEqual([
      false,
      "Host logical '*.' has wildcard but no base domain",
    ]);
    expect(validateHostLogical('*.foo_bar.com')).toEqual([
      false,
      "Host logical '*.foo_bar.com' base domain 'foo_bar.com' is not a valid DNS hostname",
    ]);

    const baseDomainLabels = [
      'a'.repeat(63),
      'b'.repeat(63),
      'c'.repeat(63),
      'd'.repeat(61),
    ];
    const baseDomain = baseDomainLabels.join('.');
    const wildcard = `*.${baseDomain}`;
    expect(validateHostLogical(wildcard)).toEqual([
      false,
      `Host logical '${wildcard}' exceeds 253 characters`,
    ]);
  });

  it('validates non-wildcard host logicals', () => {
    expect(validateHostLogical('example.com')).toEqual([true, null]);
    expect(validateHostLogical('bad_host')).toEqual([
      false,
      "Host logical 'bad_host' is not a valid DNS hostname",
    ]);

    const nearLimitLabels = [
      'b'.repeat(63),
      'c'.repeat(63),
      'd'.repeat(63),
      'e'.repeat(61),
    ];
    const hostAtLimit = nearLimitLabels.join('.');
    expect(hostAtLimit.length).toBe(253);
    expect(validateHostLogical(hostAtLimit)).toEqual([true, null]);

    const tooLongHost = `${hostAtLimit}.x`;
    expect(validateHostLogical(tooLongHost)).toEqual([
      false,
      `Host logical '${tooLongHost}' is not a valid DNS hostname`,
    ]);

    expect(validateHostLogical('example-.com')).toEqual([
      false,
      "Host logical 'example-.com' is not a valid DNS hostname",
    ]);
  });

  it('validates collections of host logicals', () => {
    expect(validateHostLogicals(null)).toEqual([true, null]);
    expect(validateHostLogicals([])).toEqual([true, null]);

    expect(
      validateHostLogicals(['example.com', '*.example.com'])
    ).toEqual([true, null]);

    expect(validateHostLogicals(['bad_host'])).toEqual([
      false,
      "Host logical 'bad_host' is not a valid DNS hostname",
    ]);
  });
});

describe('URI helpers', () => {
  it('creates logical and host logical URIs', () => {
    expect(createLogicalUri('/foo/bar')).toBe('naylence:///foo/bar');
    expect(createHostLogicalUri('example.com')).toBe('naylence://example.com/');
  });

  it('creates hostname-notation logical URIs', () => {
    expect(createLogicalUri('/foo/bar', true)).toBe('naylence://bar.foo/');
  });

  it('transforms wildcard patterns to DNS constraints', () => {
    expect(convertWildcardLogicalToDnsConstraint('*.example')).toBe('.example');
    expect(convertWildcardLogicalToDnsConstraint('example')).toBe('example');

    expect(
      logicalPatternsToDnsConstraints(['*.a', 'b'])
    ).toEqual(['.a', 'b']);
  });
});

describe('pool address helpers', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    parseAddressComponentsMock.mockReset();
  });

  afterEach(() => {
    restoreEnvValue('NODE_ENV', originalNodeEnv);
  });

  it('matches pool address when participants, host, and path align', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'addr') {
        return ['team', 'svc.pool', '/path'];
      }
      return ['team', '*.pool', '/path'];
    });

    expect(matchesPoolAddress('addr', 'pool')).toBe(true);
  });

  it('rejects pool address when participants differ or hosts do not match', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'first') {
        return ['alpha', 'svc.one', '/a'];
      }
      return ['beta', '*.one', '/a'];
    });
    expect(matchesPoolAddress('first', 'second')).toBe(false);

    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'first') {
        return ['team', 'svc.other', '/a'];
      }
      return ['team', '*.one', '/a'];
    });
    expect(matchesPoolAddress('first', 'second')).toBe(false);
  });

  it('requires paths to match when both present', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'addr') {
        return ['team', 'svc.pool', '/one'];
      }
      return ['team', '*.pool', '/two'];
    });

    expect(matchesPoolAddress('addr', 'pool')).toBe(false);
  });

  it('matches when only paths are provided without hosts', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'addr') {
        return ['team', null, '/only'];
      }
      return ['team', null, '/only'];
    });

    expect(matchesPoolAddress('addr', 'pool')).toBe(true);
  });

  it('handles parse errors with debug logging in non-production environments', () => {
    process.env.NODE_ENV = 'test';
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    parseAddressComponentsMock.mockImplementation(() => {
      throw new Error('parse failure');
    });

    expect(matchesPoolAddress('addr', 'pool')).toBe(false);
    expect(debugSpy).toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  it('suppresses debug logging in production', () => {
    process.env.NODE_ENV = 'production';
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    parseAddressComponentsMock.mockImplementation(() => {
      throw new Error('parse failure');
    });

    expect(matchesPoolAddress('addr', 'pool')).toBe(false);
    expect(debugSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  it('extracts pool address base when host contains wildcard', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'pool') {
        return ['team', '*.cluster', '/path'];
      }
      return ['team', 'svc.cluster', '/path'];
    });

    expect(extractPoolAddressBase('pool')).toBe('team@cluster/path');
    expect(extractPoolAddressBase('addr')).toBeNull();
  });

  it('returns null when pool host wildcard has no base or parse fails', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'empty') {
        return ['team', '*.', '/path'];
      }
      throw new Error('parse failure');
    });

    expect(extractPoolAddressBase('empty')).toBeNull();
    expect(extractPoolAddressBase('error')).toBeNull();
  });

  it('detects pool addresses based on host', () => {
    parseAddressComponentsMock.mockImplementation(address => {
      if (address === 'pool') {
        return ['team', '*.cluster', '/p'];
      }
      if (address === 'addr') {
        return ['team', 'svc.cluster', '/p'];
      }
      throw new Error('parse failure');
    });

    expect(isPoolAddress('pool')).toBe(true);
    expect(isPoolAddress('addr')).toBe(false);
    expect(isPoolAddress('error')).toBe(false);
  });
});
