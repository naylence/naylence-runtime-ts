import type { LoadBalancerStickinessManager } from './load-balancer-stickiness-manager.js';
import {
  LOAD_BALANCER_STICKINESS_MANAGER_FACTORY_BASE_TYPE,
  LoadBalancerStickinessManagerFactory,
  type LoadBalancerStickinessManagerConfig,
} from './load-balancer-stickiness-manager-factory.js';
import { SimpleLoadBalancerStickinessManager } from './simple-load-balancer-stickiness-manager.js';

export interface SimpleLoadBalancerStickinessManagerConfig
  extends LoadBalancerStickinessManagerConfig {
  type: 'SimpleLoadBalancerStickinessManager';
}

export const FACTORY_META = {
  base: LOAD_BALANCER_STICKINESS_MANAGER_FACTORY_BASE_TYPE,
  key: 'SimpleLoadBalancerStickinessManager',
} as const;

export class SimpleLoadBalancerStickinessManagerFactory extends LoadBalancerStickinessManagerFactory<SimpleLoadBalancerStickinessManagerConfig> {
  public readonly type = 'SimpleLoadBalancerStickinessManager';
  public readonly isDefault = true;

  public async create(
    config?:
      | SimpleLoadBalancerStickinessManagerConfig
      | Record<string, unknown>
      | null
  ): Promise<LoadBalancerStickinessManager> {
    let resolvedConfig: SimpleLoadBalancerStickinessManagerConfig | null = null;

    if (config && typeof config === 'object') {
      resolvedConfig = {
        type: this.type,
        ...(config as Record<string, unknown>),
      } as SimpleLoadBalancerStickinessManagerConfig;
    }

    return new SimpleLoadBalancerStickinessManager(resolvedConfig);
  }
}

export default SimpleLoadBalancerStickinessManagerFactory;
