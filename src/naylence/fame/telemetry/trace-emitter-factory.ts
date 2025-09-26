import type { CreateResourceOptions } from 'naylence-factory';
import { AbstractResourceFactory, createDefaultResource, createResource, registerFactory } from 'naylence-factory';

import type { TraceEmitter } from './trace-emitter.js';
import type { TraceEmitterConfig } from './trace-emitter-config.js';

export const TRACE_EMITTER_FACTORY_BASE_TYPE = 'TraceEmitterFactory';

export abstract class TraceEmitterFactory<
  C extends TraceEmitterConfig = TraceEmitterConfig
> extends AbstractResourceFactory<TraceEmitter, C> {
  public abstract create(
    config?: C | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TraceEmitter>;

  public static async createTraceEmitter(
    config?: TraceEmitterConfig | Record<string, unknown> | null,
    options: CreateResourceOptions = {}
  ): Promise<TraceEmitter> {
    const traceEmitter = config
      ? await createResource<TraceEmitter>(TRACE_EMITTER_FACTORY_BASE_TYPE, config, options)
      : await createDefaultResource<TraceEmitter>(TRACE_EMITTER_FACTORY_BASE_TYPE, null, options);

    if (!traceEmitter) {
      throw new Error('Failed to create trace emitter');
    }

    return traceEmitter;
  }
}

class NoopTraceEmitter implements TraceEmitter {
  public readonly priority = 1000;
}

class NoopTraceEmitterFactory extends TraceEmitterFactory {
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
  { isDefault: true, priority: 100 }
);
