/**
 * Envelope context management for cross-platform environments
 *
 * This provides similar functionality to Python's envelope_context using AsyncLocalStorage in Node.js
 * and a simple context stack in browsers.
 */

import { EnvelopeSnapshot } from "./logging-types.js";

// Cross-platform context storage
class EnvelopeContextManager {
  private nodeStorage: any = null;
  private browserStack: EnvelopeSnapshot[] = [];

  constructor() {
    // Try to use AsyncLocalStorage in Node.js environments
    this.initializeStorage();
  }

  private initializeStorage(): void {
    // Only try to load AsyncLocalStorage in Node.js environments
    if (typeof globalThis !== "undefined" && (globalThis as any).process?.versions?.node) {
      try {
        // Try to require async_hooks synchronously - this will only work in Node.js
        // The bundler will handle this gracefully for browser builds
        if (typeof require !== "undefined") {
          const { AsyncLocalStorage } = require("async_hooks");
          this.nodeStorage = new AsyncLocalStorage();
        }
      } catch {
        // Fall back to browser-style stack if AsyncLocalStorage isn't available
        this.nodeStorage = null;
      }
    }
  }

  /**
   * Get the current envelope context
   */
  getCurrentContext(): EnvelopeSnapshot | undefined {
    if (this.nodeStorage) {
      return this.nodeStorage.getStore();
    }

    // Browser fallback - return the top of the stack
    return this.browserStack[this.browserStack.length - 1];
  }

  /**
   * Run a function with envelope context
   */
  runWithContext<T>(context: EnvelopeSnapshot, fn: () => T): T {
    if (this.nodeStorage) {
      return this.nodeStorage.run(context, fn);
    }

    // Browser fallback - use a simple stack
    this.browserStack.push(context);
    try {
      return fn();
    } finally {
      this.browserStack.pop();
    }
  }

  /**
   * Run an async function with envelope context
   */
  async runWithContextAsync<T>(context: EnvelopeSnapshot, fn: () => Promise<T>): Promise<T> {
    if (this.nodeStorage) {
      return this.nodeStorage.run(context, fn);
    }

    // Browser fallback - use a simple stack
    this.browserStack.push(context);
    try {
      return await fn();
    } finally {
      this.browserStack.pop();
    }
  }
}

// Global instance
const envelopeContextManager = new EnvelopeContextManager();

/**
 * Get the current envelope context
 */
export function getCurrentEnvelope(): EnvelopeSnapshot | undefined {
  return envelopeContextManager.getCurrentContext();
}

export function currentTraceId(): string | undefined {
  return envelopeContextManager.getCurrentContext()?.trace_id;
}

/**
 * Context manager function (similar to Python's envelope_context)
 */
export function withEnvelopeContext<T>(
  envelope: { trace_id?: string; id?: string; flow_id?: string },
  fn: () => T
): T {
  const context: EnvelopeSnapshot = {};
  if (envelope.trace_id !== undefined) context.trace_id = envelope.trace_id;
  if (envelope.id !== undefined) context.id = envelope.id;
  if (envelope.flow_id !== undefined) context.flow_id = envelope.flow_id;
  return envelopeContextManager.runWithContext(context, fn);
}

/**
 * Async context manager function
 */
export async function withEnvelopeContextAsync<T>(
  envelope: { trace_id?: string; id?: string; flow_id?: string },
  fn: () => Promise<T>
): Promise<T> {
  const context: EnvelopeSnapshot = {};
  if (envelope.trace_id !== undefined) context.trace_id = envelope.trace_id;
  if (envelope.id !== undefined) context.id = envelope.id;
  if (envelope.flow_id !== undefined) context.flow_id = envelope.flow_id;
  return envelopeContextManager.runWithContextAsync(context, fn);
}

/**
 * Class-based context manager (similar to Python's context manager protocol)
 */
export class EnvelopeContext {
  constructor(private envelope: { trace_id?: string; id?: string; flow_id?: string }) {}

  run<T>(fn: () => T): T {
    return withEnvelopeContext(this.envelope, fn);
  }

  async runAsync<T>(fn: () => Promise<T>): Promise<T> {
    return withEnvelopeContextAsync(this.envelope, fn);
  }
}
