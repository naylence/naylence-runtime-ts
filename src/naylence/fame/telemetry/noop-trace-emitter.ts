import { BaseTraceEmitter } from "./base-trace-emitter.js";
import type { TraceSpan, TraceSpanOptions, TraceSpanScope } from "./trace-emitter.js";

class NoopTraceSpan implements TraceSpan {
  public setAttribute(): void {}
  public recordException(): void {}
  public setStatusError(): void {}
}

class NoopTraceSpanScope implements TraceSpanScope {
  private readonly span: TraceSpan;

  constructor(span: TraceSpan) {
    this.span = span;
  }

  public enter(): TraceSpan {
    return this.span;
  }

  public exit(): void {}
}

export class NoopTraceEmitter extends BaseTraceEmitter {
  public startSpan(_name: string, _options?: TraceSpanOptions): TraceSpanScope {
    void _options;
    return new NoopTraceSpanScope(new NoopTraceSpan());
  }
}
