import type { ResourceConfig } from '@naylence/factory';

export interface TraceEmitterConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}
