import type {
  Attributes,
  AttributeValue,
  Link,
  Span as OtelSpan,
  SpanOptions,
  Tracer,
} from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';

import { BaseTraceEmitter } from './base-trace-emitter.js';
import type {
  TraceSpan,
  TraceSpanOptions,
  TraceSpanScope,
} from './trace-emitter.js';
import {
  resetOtelSpanId,
  resetOtelTraceId,
  setOtelSpanId,
  setOtelTraceId,
} from './otel-context.js';
import type { OtelLifecycleControl } from './otel-setup.js';
import type { AuthInjectionStrategy } from '../security/auth/auth-injection-strategy.js';

class OpenTelemetryTraceSpan implements TraceSpan {
  public constructor(private readonly span: OtelSpan) {}

  public setAttribute(key: string, value: unknown): void {
    try {
      this.span.setAttribute(key, normalizeAttributeValue(value));
    } catch {
      // Ignore telemetry attribute errors
    }
  }

  public recordException(error: unknown): void {
    try {
      if (error instanceof Error) {
        this.span.recordException(error);
      } else {
        this.span.recordException(new Error(String(error)));
      }
    } catch {
      // Ignore telemetry recording errors
    }
  }

  public setStatusError(description?: string): void {
    try {
      const status: { code: SpanStatusCode; message?: string } = {
        code: SpanStatusCode.ERROR,
      };
      if (description !== undefined) {
        status.message = description;
      }
      this.span.setStatus(status);
    } catch {
      // Ignore telemetry status errors
    }
  }
}

class OpenTelemetrySpanScope implements TraceSpanScope {
  private readonly wrapper: OpenTelemetryTraceSpan;
  private traceToken: string | null | undefined;
  private spanToken: string | null | undefined;
  private entered = false;

  public constructor(private readonly span: OtelSpan) {
    this.wrapper = new OpenTelemetryTraceSpan(span);
  }

  public enter(): TraceSpan {
    if (!this.entered) {
      this.entered = true;
      const spanContext = this.span.spanContext();
      this.traceToken = setOtelTraceId(spanContext?.traceId ?? null);
      this.spanToken = setOtelSpanId(spanContext?.spanId ?? null);
    }
    return this.wrapper;
  }

  public exit(): void {
    try {
      this.span.end();
    } catch {
      // Ignore span termination errors
    } finally {
      if (this.traceToken !== undefined) {
        resetOtelTraceId(this.traceToken);
        this.traceToken = undefined;
      }
      if (this.spanToken !== undefined) {
        resetOtelSpanId(this.spanToken);
        this.spanToken = undefined;
      }
    }
  }
}

export class OpenTelemetryTraceEmitter extends BaseTraceEmitter {
  private readonly tracer: Tracer;
  private lifecycle: OtelLifecycleControl | null;
  private authStrategy: AuthInjectionStrategy | null;
  private shutdownInvoked = false;

  public constructor(options: OpenTelemetryTraceEmitterOptionsInput) {
    super();
    const normalized = normalizeOpenTelemetryTraceEmitterOptions(options);
    this.tracer = normalized.tracer ?? trace.getTracer(normalized.serviceName);
    this.lifecycle = normalized.lifecycle ?? null;
    this.authStrategy = normalized.authStrategy ?? null;
  }

  public startSpan(name: string, options?: TraceSpanOptions): TraceSpanScope {
    const attributes = normalizeAttributes(options?.attributes);
    const spanOptions: SpanOptions = {};
    if (attributes) {
      spanOptions.attributes = attributes;
    }
    if (options?.links) {
      spanOptions.links = options.links as Link[];
    }

    const span = this.tracer.startSpan(name, spanOptions);

    const envelopeTraceId = options?.attributes?.['env.trace_id'];
    if (typeof envelopeTraceId === 'string') {
      this.applyEnvelopeTraceId(span, envelopeTraceId);
    }

    return new OpenTelemetrySpanScope(span);
  }

  public override async flush(): Promise<void> {
    if (this.lifecycle?.forceFlush) {
      try {
        await this.lifecycle.forceFlush();
        return;
      } catch {
        // fall through to global flush fallback
      }
    }

    try {
      const provider = trace.getTracerProvider() as unknown as {
        forceFlush?: () => Promise<void>;
      };
      if (provider && typeof provider.forceFlush === 'function') {
        await provider.forceFlush();
      }
    } catch {
      // Ignore flush errors
    }
  }

  public override async shutdown(): Promise<void> {
    if (this.shutdownInvoked) {
      return;
    }
    this.shutdownInvoked = true;

    const cleanupTasks: Array<Promise<void>> = [];

    const strategy = this.authStrategy;
    if (strategy) {
      this.authStrategy = null;
      cleanupTasks.push(
        strategy.cleanup().catch(() => {
          // Ignore auth cleanup failures
        })
      );
    }

    if (this.lifecycle?.shutdown) {
      try {
        await this.lifecycle.shutdown();
        this.lifecycle = null;
        await Promise.all(cleanupTasks);
        return;
      } catch {
        // fall through to global shutdown fallback
        this.lifecycle = null;
      }
    }

    try {
      const provider = trace.getTracerProvider() as unknown as {
        shutdown?: () => Promise<void>;
      };
      if (provider && typeof provider.shutdown === 'function') {
        await provider.shutdown();
      }
    } catch {
      // Ignore shutdown errors
    } finally {
      if (cleanupTasks.length > 0) {
        await Promise.all(cleanupTasks);
      }
    }
  }

  private applyEnvelopeTraceId(span: OtelSpan, envelopeTraceId: string): void {
    try {
      const targetTraceId = this.convertEnvTraceIdToOtel(envelopeTraceId);
      const internalSpan = span as unknown as {
        _spanContext?: { traceId: string };
      };
      if (internalSpan?._spanContext) {
        internalSpan._spanContext.traceId = targetTraceId;
      }
    } catch {
      // Ignore trace-id coercion errors
    }
  }

  private convertEnvTraceIdToOtel(envTraceId: string): string {
    const normalized = envTraceId.slice(0, 16).padEnd(16, '0');
    let hex = '';
    for (let i = 0; i < 16; i += 1) {
      const code = normalized.charCodeAt(i);
      const byte = Number.isNaN(code) ? 0 : code & 0xff;
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }
}

type OpenTelemetryTraceEmitterOptionsInput = {
  serviceName?: string;
  service_name?: string;
  tracer?: Tracer;
  lifecycle?: OtelLifecycleControl | null;
  lifeCycle?: OtelLifecycleControl | null;
  life_cycle?: OtelLifecycleControl | null;
  authStrategy?: AuthInjectionStrategy | null;
  auth_strategy?: AuthInjectionStrategy | null;
};

type NormalizedOpenTelemetryTraceEmitterOptions = {
  serviceName: string;
  tracer?: Tracer;
  lifecycle?: OtelLifecycleControl | null;
  authStrategy?: AuthInjectionStrategy | null;
};

function normalizeOpenTelemetryTraceEmitterOptions(
  input: OpenTelemetryTraceEmitterOptionsInput
): NormalizedOpenTelemetryTraceEmitterOptions {
  const source = (input ?? {}) as Record<string, unknown>;

  const serviceName =
    extractNonEmptyString(
      pickFirst<string>(source, ['serviceName', 'service_name'])
    ) ?? 'naylence-service';

  const tracer = pickFirst<Tracer | undefined>(source, ['tracer']);

  const lifecycle =
    pickFirst<OtelLifecycleControl | null>(source, [
      'lifecycle',
      'lifeCycle',
      'life_cycle',
    ]) ?? null;

  const authStrategy =
    pickFirst<AuthInjectionStrategy | null>(source, [
      'authStrategy',
      'auth_strategy',
    ]) ?? null;

  return {
    serviceName,
    tracer,
    lifecycle,
    authStrategy,
  };
}

function pickFirst<T>(
  source: Record<string, unknown>,
  keys: string[]
): T | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key] as T | undefined;
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function extractNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeAttributeValue(value: unknown): AttributeValue {
  if (Array.isArray(value)) {
    return value.map((item) => String(normalizePrimitiveAttribute(item, true)));
  }
  return normalizePrimitiveAttribute(value, false);
}

function normalizePrimitiveAttribute(
  value: unknown,
  forceString: boolean
): string | number | boolean {
  if (!forceString) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (!forceString && typeof value === 'number') {
    return value;
  }

  return String(value);
}

function normalizeAttributes(
  source?: Record<string, unknown>
): Attributes | undefined {
  if (!source) {
    return undefined;
  }

  const entries: [string, AttributeValue][] = [];
  for (const [key, raw] of Object.entries(source)) {
    entries.push([key, normalizeAttributeValue(raw)]);
  }

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
