/**
 * @fileoverview Tests for pattern-matcher.ts
 *
 * Tests cover the multi-separator glob semantics where `.`, `/`, and `@`
 * are all treated as equivalent segment separators.
 */

import {
  isRegexPattern,
  assertNotRegexPattern,
  compilePattern,
  compileGlobPattern,
  getCompiledPattern,
  getCompiledGlobPattern,
  matchPattern,
  clearPatternCache,
} from '../pattern-matcher';

describe('pattern-matcher', () => {
  beforeEach(() => {
    clearPatternCache();
  });

  describe('isRegexPattern', () => {
    it('returns true for patterns starting with ^', () => {
      expect(isRegexPattern('^test')).toBe(true);
      expect(isRegexPattern('^.*$')).toBe(true);
    });

    it('returns false for glob patterns', () => {
      expect(isRegexPattern('*')).toBe(false);
      expect(isRegexPattern('test.*.domain')).toBe(false);
      expect(isRegexPattern('test^notstart')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isRegexPattern('')).toBe(false);
    });
  });

  describe('assertNotRegexPattern', () => {
    it('does not throw for glob patterns', () => {
      expect(() => assertNotRegexPattern('*')).not.toThrow();
      expect(() => assertNotRegexPattern('test.*.domain')).not.toThrow();
    });

    it('throws for regex patterns', () => {
      expect(() => assertNotRegexPattern('^test')).toThrow(/Regex patterns are not supported/);
    });

    it('includes context in error message', () => {
      expect(() => assertNotRegexPattern('^test', 'source address')).toThrow(
        /in source address/
      );
    });
  });

  describe('glob pattern matching - basic wildcards', () => {
    it('matches exact strings', () => {
      const pattern = compileGlobPattern('hello');
      expect(pattern.match('hello')).toBe(true);
      expect(pattern.match('hello2')).toBe(false);
      expect(pattern.match('hell')).toBe(false);
    });

    it('matches * for single segment (dot separator)', () => {
      const pattern = compileGlobPattern('*.world');
      expect(pattern.match('hello.world')).toBe(true);
      expect(pattern.match('foo.world')).toBe(true);
      expect(pattern.match('hello.foo.world')).toBe(false); // * doesn't cross dots
      expect(pattern.match('.world')).toBe(true); // * can match empty
    });

    it('matches * for single segment (slash separator)', () => {
      const pattern = compileGlobPattern('*/bar');
      expect(pattern.match('foo/bar')).toBe(true);
      expect(pattern.match('baz/bar')).toBe(true);
      expect(pattern.match('foo/baz/bar')).toBe(false); // * doesn't cross slashes
      expect(pattern.match('/bar')).toBe(true); // * can match empty
    });

    it('matches * for single segment (@ separator)', () => {
      const pattern = compileGlobPattern('*@domain');
      expect(pattern.match('user@domain')).toBe(true);
      expect(pattern.match('admin@domain')).toBe(true);
      expect(pattern.match('user.name@domain')).toBe(false); // * doesn't cross dots
      expect(pattern.match('@domain')).toBe(true); // * can match empty
    });

    it('matches ** for any depth', () => {
      const pattern = compileGlobPattern('a.**');
      expect(pattern.match('a.b')).toBe(true);
      expect(pattern.match('a.b.c')).toBe(true);
      expect(pattern.match('a.b.c.d.e')).toBe(true);
      expect(pattern.match('a.')).toBe(true); // ** can match empty
    });

    it('matches ? for single character (not separator)', () => {
      const pattern = compileGlobPattern('te?t');
      expect(pattern.match('test')).toBe(true);
      expect(pattern.match('text')).toBe(true);
      expect(pattern.match('teet')).toBe(true);
      expect(pattern.match('te.t')).toBe(false); // ? doesn't match dot
      expect(pattern.match('te/t')).toBe(false); // ? doesn't match slash
      expect(pattern.match('te@t')).toBe(false); // ? doesn't match @
    });
  });

  describe('glob pattern matching - multi-separator semantics', () => {
    describe('single * wildcard stops at all separators', () => {
      it('stops at dot', () => {
        const pattern = compileGlobPattern('*');
        expect(pattern.match('hello')).toBe(true);
        expect(pattern.match('hello.world')).toBe(false);
      });

      it('stops at slash', () => {
        const pattern = compileGlobPattern('*');
        expect(pattern.match('hello/world')).toBe(false);
      });

      it('stops at @', () => {
        const pattern = compileGlobPattern('*');
        expect(pattern.match('user@domain')).toBe(false);
      });
    });

    describe('logical address matching (name@domain.fabric)', () => {
      it('matches with * wildcards in each segment', () => {
        const pattern = compileGlobPattern('*@*.fabric');
        expect(pattern.match('user@example.fabric')).toBe(true);
        expect(pattern.match('admin@prod.fabric')).toBe(true);
        expect(pattern.match('user@sub.example.fabric')).toBe(false); // * stops at dot
      });

      it('matches with ** for multi-segment domains', () => {
        const pattern = compileGlobPattern('*@**.fabric');
        expect(pattern.match('user@example.fabric')).toBe(true);
        expect(pattern.match('user@sub.example.fabric')).toBe(true);
        expect(pattern.match('user@a.b.c.fabric')).toBe(true);
      });

      it('matches specific address exactly', () => {
        const pattern = compileGlobPattern('myservice@prod.example.com');
        expect(pattern.match('myservice@prod.example.com')).toBe(true);
        expect(pattern.match('myservice@staging.example.com')).toBe(false);
      });
    });

    describe('physical address matching (name@/path/to/node)', () => {
      it('matches with * wildcards in path segments', () => {
        const pattern = compileGlobPattern('service@/region/*/instance');
        expect(pattern.match('service@/region/us-east/instance')).toBe(true);
        expect(pattern.match('service@/region/eu-west/instance')).toBe(true);
        expect(pattern.match('service@/region/us-east/zone-a/instance')).toBe(false);
      });

      it('matches with ** for deep path matching', () => {
        const pattern = compileGlobPattern('service@/**');
        expect(pattern.match('service@/a')).toBe(true);
        expect(pattern.match('service@/a/b')).toBe(true);
        expect(pattern.match('service@/a/b/c/d')).toBe(true);
      });

      it('matches mixed separators in physical addresses', () => {
        const pattern = compileGlobPattern('*@/*/zone.*');
        expect(pattern.match('app@/region/zone.primary')).toBe(true);
        expect(pattern.match('svc@/datacenter/zone.backup')).toBe(true);
      });
    });

    describe('complex patterns with mixed separators', () => {
      it('handles consecutive separators', () => {
        const pattern = compileGlobPattern('a.@/b');
        expect(pattern.match('a.@/b')).toBe(true);
      });

      it('handles wildcards between different separators', () => {
        const pattern = compileGlobPattern('*.*@*/*');
        expect(pattern.match('a.b@c/d')).toBe(true);
        expect(pattern.match('x.y@z/w')).toBe(true);
      });

      it('handles ** spanning multiple separator types', () => {
        const pattern = compileGlobPattern('start.**end');
        expect(pattern.match('start.a.b@c/d.end')).toBe(true);
        expect(pattern.match('start.end')).toBe(true);
      });
    });
  });

  describe('glob pattern matching - edge cases', () => {
    it('matches empty pattern only against empty string', () => {
      const pattern = compileGlobPattern('');
      expect(pattern.match('')).toBe(true);
      expect(pattern.match('a')).toBe(false);
    });

    it('matches pattern with only *', () => {
      const pattern = compileGlobPattern('*');
      expect(pattern.match('')).toBe(true);
      expect(pattern.match('anything')).toBe(true);
      expect(pattern.match('no.dots')).toBe(false);
    });

    it('matches pattern with only **', () => {
      const pattern = compileGlobPattern('**');
      expect(pattern.match('')).toBe(true);
      expect(pattern.match('anything')).toBe(true);
      expect(pattern.match('a.b.c@d/e/f')).toBe(true);
    });

    it('escapes regex special characters', () => {
      const pattern = compileGlobPattern('test.*.example.com');
      expect(pattern.match('test.foo.example.com')).toBe(true);
      expect(pattern.match('testXfoo.example.com')).toBe(false); // dot is literal
    });

    it('handles parentheses in pattern', () => {
      const pattern = compileGlobPattern('func(*)');
      expect(pattern.match('func(arg)')).toBe(true);
      expect(pattern.match('func()')).toBe(true);
    });

    it('handles brackets in pattern', () => {
      const pattern = compileGlobPattern('arr[*]');
      expect(pattern.match('arr[0]')).toBe(true);
      expect(pattern.match('arr[123]')).toBe(true);
    });

    it('handles plus and other regex chars', () => {
      const pattern = compileGlobPattern('a+b');
      expect(pattern.match('a+b')).toBe(true);
      expect(pattern.match('ab')).toBe(false);
      expect(pattern.match('aab')).toBe(false);
    });
  });

  describe('regex pattern matching (advanced policy)', () => {
    it('matches regex patterns starting with ^', () => {
      const pattern = compilePattern('^test.*$');
      expect(pattern.isRegex).toBe(true);
      expect(pattern.match('test123')).toBe(true);
      expect(pattern.match('testing')).toBe(true);
      expect(pattern.match('nottest')).toBe(false);
    });

    it('rejects regex patterns in compileGlobPattern', () => {
      expect(() => compileGlobPattern('^test.*$')).toThrow(/Regex patterns are not supported/);
    });
  });

  describe('pattern caching', () => {
    it('caches compiled patterns', () => {
      const p1 = getCompiledPattern('test.*');
      const p2 = getCompiledPattern('test.*');
      expect(p1).toBe(p2);
    });

    it('caches glob patterns separately', () => {
      const p1 = getCompiledGlobPattern('test.*');
      const p2 = getCompiledGlobPattern('test.*');
      expect(p1).toBe(p2);
    });

    it('clears cache', () => {
      const p1 = getCompiledPattern('test.*');
      clearPatternCache();
      const p2 = getCompiledPattern('test.*');
      expect(p1).not.toBe(p2);
    });
  });

  describe('matchPattern helper', () => {
    it('matches glob patterns', () => {
      expect(matchPattern('hello.*', 'hello.world')).toBe(true);
      expect(matchPattern('hello.*', 'hello.foo.bar')).toBe(false);
    });

    it('matches regex patterns', () => {
      expect(matchPattern('^hello.*', 'hello.world')).toBe(true);
      expect(matchPattern('^hello.*', 'world.hello')).toBe(false);
    });
  });

  describe('CompiledPattern interface', () => {
    it('exposes source pattern', () => {
      const pattern = compileGlobPattern('test.*');
      expect(pattern.source).toBe('test.*');
    });

    it('exposes isRegex flag for glob', () => {
      const pattern = compileGlobPattern('test.*');
      expect(pattern.isRegex).toBe(false);
    });

    it('exposes isRegex flag for regex', () => {
      const pattern = compilePattern('^test.*');
      expect(pattern.isRegex).toBe(true);
    });
  });
});
