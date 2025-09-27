let currentTraceId: string | null = null;
let currentSpanId: string | null = null;

export function getOtelTraceId(): string | null {
  return currentTraceId;
}

export function getOtelSpanId(): string | null {
  return currentSpanId;
}

export function setOtelTraceId(traceId: string | null): string | null {
  const previous = currentTraceId;
  currentTraceId = traceId;
  return previous;
}

export function setOtelSpanId(spanId: string | null): string | null {
  const previous = currentSpanId;
  currentSpanId = spanId;
  return previous;
}

export function resetOtelTraceId(previous: string | null): void {
  currentTraceId = previous;
}

export function resetOtelSpanId(previous: string | null): void {
  currentSpanId = previous;
}
