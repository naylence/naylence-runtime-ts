import type { ResourceConfig } from "naylence-factory";

export interface TransportListenerConfig extends ResourceConfig {
  type: string;
  host?: string;
  port?: number;
  authorizer?: Record<string, unknown> | null;
  [key: string]: unknown;
}
