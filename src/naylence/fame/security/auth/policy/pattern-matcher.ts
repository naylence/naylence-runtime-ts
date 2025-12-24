/**
 * Pattern matching utilities for authorization policies.
 *
 * Supports:
 * - Glob patterns: `*` (single segment), `**` (any depth), `?` (single char)
 * - Regex patterns: patterns starting with `^` (for advanced/BSL use only)
 *
 * The OSS/basic policy uses glob-only matching via `compileGlobPattern()`.
 * The advanced/BSL policy may use `compilePattern()` which interprets `^` as regex.
 */

/**
 * Compiled pattern for efficient repeated matching.
 */
export interface CompiledPattern {
  readonly source: string;
  readonly isRegex: boolean;
  match(value: string): boolean;
}

/**
 * Checks if a pattern string is a regex pattern.
 * Regex patterns start with `^`.
 */
export function isRegexPattern(pattern: string): boolean {
  return pattern.startsWith('^');
}

/**
 * Asserts that a pattern is not a regex pattern.
 * Throws an error if the pattern starts with `^`.
 *
 * Use this in OSS/basic policy to reject regex patterns.
 *
 * @param pattern - The pattern to check
 * @param context - Optional context for the error message (e.g., "address", "scope")
 * @throws Error if the pattern is a regex pattern
 */
export function assertNotRegexPattern(
  pattern: string,
  context?: string
): void {
  if (pattern.startsWith('^')) {
    const contextStr = context ? ` in ${context}` : '';
    throw new Error(
      `Regex patterns are not supported${contextStr} in OSS/basic policy. ` +
        `Pattern "${pattern}" starts with '^'. Use glob patterns instead.`
    );
  }
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts a glob pattern to a regex pattern.
 *
 * Glob syntax:
 * - `*` matches a single segment (no dots)
 * - `**` matches any number of segments (including zero)
 * - Other characters are matched literally
 *
 * @param glob - The glob pattern to convert
 * @returns A regex pattern string (without anchors)
 */
function globToRegex(glob: string): string {
  const parts: string[] = [];
  let i = 0;

  while (i < glob.length) {
    if (glob[i] === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches any characters (including dots)
        parts.push('.*');
        i += 2;
      } else {
        // `*` matches any characters except dots (single segment)
        parts.push('[^.]*');
        i += 1;
      }
    } else if (glob[i] === '?') {
      // `?` matches a single character (not a dot)
      parts.push('[^.]');
      i += 1;
    } else {
      // Escape and add literal character
      parts.push(escapeRegex(glob[i]));
      i += 1;
    }
  }

  return parts.join('');
}

/**
 * Compiles a pattern string into an efficient matcher.
 *
 * @param pattern - Glob pattern or regex (starting with `^`)
 * @returns A compiled pattern object
 * @throws Error if the regex pattern is invalid
 */
export function compilePattern(pattern: string): CompiledPattern {
  if (isRegexPattern(pattern)) {
    // Regex pattern - compile directly
    const regex = new RegExp(pattern);
    return {
      source: pattern,
      isRegex: true,
      match: (value: string) => regex.test(value),
    };
  }

  // Glob pattern - convert to regex with anchors
  const regexStr = `^${globToRegex(pattern)}$`;
  const regex = new RegExp(regexStr);

  return {
    source: pattern,
    isRegex: false,
    match: (value: string) => regex.test(value),
  };
}

/**
 * Compiles a pattern string as a glob pattern only (no regex interpretation).
 *
 * This is the preferred method for OSS/basic policy evaluation.
 * Patterns starting with `^` are rejected with an error.
 *
 * @param pattern - Glob pattern (regex patterns rejected)
 * @param context - Optional context for error messages
 * @returns A compiled pattern object
 * @throws Error if pattern starts with `^` (regex attempt)
 */
export function compileGlobPattern(
  pattern: string,
  context?: string
): CompiledPattern {
  // Reject regex patterns in OSS/basic policy
  assertNotRegexPattern(pattern, context);

  // Convert glob to regex with anchors
  const regexStr = `^${globToRegex(pattern)}$`;
  const regex = new RegExp(regexStr);

  return {
    source: pattern,
    isRegex: false,
    match: (value: string) => regex.test(value),
  };
}

/**
 * Cache for compiled patterns to avoid recompilation.
 */
const patternCache = new Map<string, CompiledPattern>();

/**
 * Cache for glob-only compiled patterns.
 */
const globPatternCache = new Map<string, CompiledPattern>();

/**
 * Gets or compiles a pattern, with caching.
 *
 * @param pattern - Glob pattern or regex
 * @returns A compiled pattern object
 */
export function getCompiledPattern(pattern: string): CompiledPattern {
  let compiled = patternCache.get(pattern);
  if (!compiled) {
    compiled = compilePattern(pattern);
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Gets or compiles a glob-only pattern, with caching.
 *
 * This is the preferred method for OSS/basic policy evaluation.
 * Patterns are always treated as globs, never regex.
 *
 * @param pattern - Glob pattern (never interpreted as regex)
 * @returns A compiled pattern object
 */
export function getCompiledGlobPattern(pattern: string): CompiledPattern {
  let compiled = globPatternCache.get(pattern);
  if (!compiled) {
    compiled = compileGlobPattern(pattern);
    globPatternCache.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Matches a value against a pattern string.
 *
 * @param pattern - Glob pattern or regex (starting with `^`)
 * @param value - The value to match
 * @returns True if the value matches the pattern
 */
export function matchPattern(pattern: string, value: string): boolean {
  return getCompiledPattern(pattern).match(value);
}

/**
 * Clears the pattern cache.
 * Useful for testing or when memory is a concern.
 */
export function clearPatternCache(): void {
  patternCache.clear();
}
