import type { FameDeliveryContext, FameEnvelope } from '@naylence/core';
import type { NodeLike } from '../../node/node-like.js';
import type {
  TraceSpan,
  TraceSpanOptions,
  TraceSpanScope,
} from '../trace-emitter.js';
import { BaseTraceEmitter } from '../base-trace-emitter.js';

class MockSpan implements TraceSpan {
  public setAttribute(): void {}
  public recordException(): void {}
  public setStatusError(): void {}
}

class MockScope implements TraceSpanScope {
  private readonly span: TraceSpan;
  public exited = false;

  public constructor(span: TraceSpan) {
    this.span = span;
  }

  public enter(): TraceSpan {
    return this.span;
  }

  public exit(): void {
    this.exited = true;
  }
}

class TestTraceEmitter extends BaseTraceEmitter {
  public lastSpanName: string | null = null;
  public lastSpanAttributes: Record<string, unknown> | undefined;

  public startSpan(name: string, options?: TraceSpanOptions): TraceSpanScope {
    this.lastSpanName = name;
    this.lastSpanAttributes = options?.attributes as
      | Record<string, unknown>
      | undefined;
    return new MockScope(new MockSpan());
  }
}

describe('BaseTraceEmitter', () => {
  const node = { id: 'node-1', sid: 'sid-1' } as unknown as NodeLike;
  const envelope = {
    id: 'env-1',
    traceId: 'trace-1',
    corrId: 'corr-1',
    flowId: 'flow-1',
    seqId: 1,
  } as unknown as FameEnvelope;

  it('accepts snake_case delivery context aliases', async () => {
    const emitter = new TestTraceEmitter();
    const context = {
      from_system_id: 'node-from',
      origin_type: 'edge',
    } as unknown as FameDeliveryContext;

    await emitter.onEnvelopeReceived(node, envelope, context);

    expect(emitter.lastSpanName).toBe('env.received');
    expect(emitter.lastSpanAttributes).toMatchObject({
      'from.node_id': 'node-from',
      'from.origin_type': 'edge',
    });
  });

  it('accepts camelCase delivery context aliases', async () => {
    const emitter = new TestTraceEmitter();
    const context = {
      fromSystemId: 'node-from',
      originType: 'egde-camel',
    } as unknown as FameDeliveryContext;

    await emitter.onEnvelopeReceived(node, envelope, context);

    expect(emitter.lastSpanName).toBe('env.received');
    expect(emitter.lastSpanAttributes).toMatchObject({
      'from.node_id': 'node-from',
      'from.origin_type': 'egde-camel',
    });
  });
});
