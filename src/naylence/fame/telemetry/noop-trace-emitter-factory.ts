import type { TraceEmitter } from './trace-emitter.js';
import type { TraceEmitterConfig } from './trace-emitter-config.js';
import { TRACE_EMITTER_FACTORY_BASE_TYPE, TraceEmitterFactory } from './trace-emitter-factory.js';
import { NoopTraceEmitter } from './noop-trace-emitter.js';
import { registerFactory } from 'naylence-factory';

export interface NoopTraceEmitterConfig extends TraceEmitterConfig {
  type: 'NoopTraceEmitter';
}

export class NoopTraceEmitterFactory extends TraceEmitterFactory<NoopTraceEmitterConfig> {
  public readonly type = 'NoopTraceEmitter';
  public readonly isDefault = true;
  public readonly priority = 100;

  public async create(): Promise<TraceEmitter> {
    return new NoopTraceEmitter();
  }
}

registerFactory(
  TRACE_EMITTER_FACTORY_BASE_TYPE,
  'NoopTraceEmitter',
  NoopTraceEmitterFactory,
  { isDefault: true, priority: 100 },
);
