import type { FameAddress, FameService } from '@naylence/core';

export interface ServiceManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerService(
    serviceName: string,
    service: FameService
  ): Promise<FameAddress>;
  getLocalServices(): Map<FameAddress, FameService>;
  resolveByCapability(capability: unknown): FameService;
  resolveAddressByCapability(
    capabilities: string[]
  ): Promise<FameAddress | null>;
}

export interface ServiceManagerProvider {
  getServiceManager(): ServiceManager;
}
