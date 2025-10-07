import type { NodeEventListener } from '../node/node-event-listener.js';

/**
 * Minimal span contract used by telemetry emitters.
 */
export interface TraceSpan {
  setAttribute(key: string, value: unknown): void;
  recordException(error: unknown): void;
  setStatusError(description?: string): void;
}

/**
 * Represents a lightweight context manager for a telemetry span.
 * Implementations should start the span on {@link enter} and
 * perform any cleanup on {@link exit}.
 */
export interface TraceSpanScope {
  enter(): TraceSpan;
  exit(error?: unknown): void;
}

export interface TraceSpanOptions {
  attributes?: Record<string, unknown> | undefined;
  links?: unknown[] | undefined;
}

export interface TraceEmitter extends NodeEventListener {
  startSpan(name: string, options?: TraceSpanOptions): TraceSpanScope;

  flush?(): Promise<void>;

  shutdown?(): Promise<void>;
}
