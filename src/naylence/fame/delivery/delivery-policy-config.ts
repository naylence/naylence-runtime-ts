import type { ResourceConfig } from 'naylence-factory';

export interface DeliveryPolicyConfig extends ResourceConfig {
  type: string;
  [key: string]: unknown;
}
