/**
 * Formatting utilities for terminal output and timestamps.
 */

/**
 * ANSI color codes for terminal output.
 */
export enum AnsiColor {
  RESET = '\u001b[0m',
  BLACK = '\u001b[30m',
  RED = '\u001b[31m',
  GREEN = '\u001b[32m',
  YELLOW = '\u001b[33m',
  BLUE = '\u001b[34m',
  MAGENTA = '\u001b[35m',
  CYAN = '\u001b[36m',
  WHITE = '\u001b[37m',
  GRAY = '\u001b[90m',
  BRIGHT_RED = '\u001b[91m',
  BRIGHT_GREEN = '\u001b[92m',
  BRIGHT_YELLOW = '\u001b[93m',
  BRIGHT_BLUE = '\u001b[94m',
  BRIGHT_MAGENTA = '\u001b[95m',
  BRIGHT_CYAN = '\u001b[96m',
  BRIGHT_WHITE = '\u001b[97m',
}

/**
 * Get current timestamp in ISO format with microseconds and Z suffix.
 * @returns ISO timestamp string with microsecond precision and UTC timezone
 */
export function formatTimestamp(): string {
  const now = new Date();
  const isoString = now.toISOString();
  // JavaScript Date.toISOString() already provides millisecond precision
  // and Z suffix, which matches the Python implementation
  return isoString;
}

/**
 * Colorize text with the given ANSI color code.
 * @param text The text to colorize
 * @param color The ANSI color code to apply
 * @returns The colorized text with reset code appended
 */
export function color(text: string, color: AnsiColor): string {
  return `${color}${text}${AnsiColor.RESET}`;
}

/**
 * Internal function to check color support (for testing purposes)
 */
function _supportsColor(): boolean {
  // Check if we're in a Node.js environment
  if (typeof process !== 'undefined' && process.env) {
    // Check for CI environments that support colors
    if (process.env.CI && ['true', '1'].includes(process.env.CI)) {
      return true;
    }

    // Check for NO_COLOR environment variable
    if (process.env.NO_COLOR) {
      return false;
    }

    // Check for FORCE_COLOR environment variable
    if (process.env.FORCE_COLOR) {
      return true;
    }

    // Check if stdout is a TTY (terminal)
    if (process.stdout && process.stdout.isTTY) {
      return true;
    }
  }

  // In browser environments, assume no color support by default
  return false;
}

/**
 * Check if the current environment supports ANSI colors.
 * @returns true if ANSI colors are supported, false otherwise
 */
export function supportsColor(): boolean {
  return _supportsColor();
}

/**
 * Conditionally colorize text based on environment support.
 * @param text The text to colorize
 * @param color The ANSI color code to apply
 * @returns The colorized text if colors are supported, plain text otherwise
 */
export function safeColor(text: string, color: AnsiColor): string {
  return supportsColor() ? `${color}${text}${AnsiColor.RESET}` : text;
}
