import type { ResourceConfig } from '@naylence/factory';

export interface TransportListenerConfig extends ResourceConfig {
  type: string;
  host?: string;
  port?: number;
  authorizer?: Record<string, unknown> | null;
  /**
   * Whether this listener is enabled. Defaults to true.
   * Disabled listeners are skipped during node initialization.
   */
  enabled?: boolean;
  [key: string]: unknown;
}
