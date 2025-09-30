/**
 * Tests for formatter utilities
 */

import {
  AnsiColor,
  formatTimestamp,
  color,
  safeColor,
  supportsColor,
} from "../naylence/fame/util/formatter";

describe("Formatter", () => {
  describe("AnsiColor enum", () => {
    it("should have correct ANSI codes", () => {
      expect(AnsiColor.RESET).toBe("\u001b[0m");
      expect(AnsiColor.RED).toBe("\u001b[31m");
      expect(AnsiColor.GREEN).toBe("\u001b[32m");
      expect(AnsiColor.BLUE).toBe("\u001b[34m");
      expect(AnsiColor.BRIGHT_RED).toBe("\u001b[91m");
    });
  });

  describe("formatTimestamp", () => {
    it("should return ISO timestamp with Z suffix", () => {
      const timestamp = formatTimestamp();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should return current time", () => {
      const before = Date.now();
      const timestamp = formatTimestamp();
      const after = Date.now();
      const timestampMs = new Date(timestamp).getTime();

      expect(timestampMs).toBeGreaterThanOrEqual(before);
      expect(timestampMs).toBeLessThanOrEqual(after);
    });
  });

  describe("color", () => {
    it("should wrap text with color codes", () => {
      const result = color("hello", AnsiColor.RED);
      expect(result).toBe("\u001b[31mhello\u001b[0m");
    });

    it("should wrap text with bright colors", () => {
      const result = color("world", AnsiColor.BRIGHT_GREEN);
      expect(result).toBe("\u001b[92mworld\u001b[0m");
    });

    it("should handle empty text", () => {
      const result = color("", AnsiColor.BLUE);
      expect(result).toBe("\u001b[34m\u001b[0m");
    });
  });

  describe("color support detection", () => {
    let originalEnv: typeof process.env;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should return false when NO_COLOR is set", () => {
      process.env = { ...originalEnv, NO_COLOR: "1" };

      expect(supportsColor()).toBe(false);
    });

    it("should return true when FORCE_COLOR is set", () => {
      process.env = { ...originalEnv, FORCE_COLOR: "1" };

      expect(supportsColor()).toBe(true);
    });
  });

  describe("safeColor", () => {
    let originalEnv: typeof process.env;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should apply color when colors are supported", () => {
      // Force color support
      process.env = { ...originalEnv, FORCE_COLOR: "1" };

      const result = safeColor("test", AnsiColor.RED);
      expect(result).toBe("\u001b[31mtest\u001b[0m");
    });

    it("should return plain text when colors are not supported", () => {
      // Disable color support
      process.env = { ...originalEnv, NO_COLOR: "1" };

      const result = safeColor("test", AnsiColor.RED);
      expect(result).toBe("test");
    });

    it("should return plain text in browser environment", () => {
      // Store original global process
      const originalGlobalProcess = (global as any).process;

      // Simulate browser environment
      delete (global as any).process;

      const result = safeColor("test", AnsiColor.RED);
      expect(result).toBe("test");

      // Restore global process
      (global as any).process = originalGlobalProcess;
    });
  });
});
