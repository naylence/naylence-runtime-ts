import {
  FameAddress,
  FameService,
  FameServiceProxy,
  isFameMessageService,
  isFameRPCService,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameMessageService,
  type InvokeProtocol,
  type ServeProtocol,
  type ServeRPCProtocol,
} from 'naylence-core';
import { createResource, ExtensionManager } from 'naylence-factory';

import type { ServiceManager } from './service-manager.js';

type MaybePromise<T> = T | Promise<T>;

type CapabilityMapInput =
  | Map<string, FameAddress>
  | Record<string, FameAddress>
  | undefined
  | null;

interface DefaultServiceManagerOptions {
  invoke: InvokeProtocol;
  serve: ServeProtocol;
  serveRpc: ServeRPCProtocol;
  capabilityMap?: CapabilityMapInput;
  pollTimeoutMs?: number | null;
  defaultServiceConfigs?: Array<Record<string, unknown>>;
}

interface RegisteredService {
  address: FameAddress;
  service: FameService;
}

export class DefaultServiceManager implements ServiceManager {
  private readonly invoke: InvokeProtocol;
  private readonly serve: ServeProtocol;
  private readonly serveRpc: ServeRPCProtocol;
  private readonly capabilityMap: Map<string, FameAddress>;
  private readonly pollTimeoutMs: number | null;
  private readonly defaultServiceConfigs: Array<Record<string, unknown>>;

  private readonly services = new Map<string, RegisteredService>();
  private started = false;
  private extensionManagerInitialized = false;

  constructor(options: DefaultServiceManagerOptions) {
    this.invoke = options.invoke;
    this.serve = options.serve;
    this.serveRpc = options.serveRpc;
    this.pollTimeoutMs = options.pollTimeoutMs ?? null;
    this.capabilityMap = this.normalizeCapabilityMap(options.capabilityMap);
    this.defaultServiceConfigs = options.defaultServiceConfigs
      ? [...options.defaultServiceConfigs]
      : [];
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.ensureExtensionManager();
    this.started = true;

    if (this.defaultServiceConfigs.length === 0) {
      return;
    }

    await this.registerDefaultServices();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await Promise.all(
      Array.from(this.services.values()).map(async ({ service }) => {
        const stopFn = (service as any)?.stop;
        if (typeof stopFn === 'function') {
          await this.resolveMaybePromise(stopFn.call(service));
        }
      })
    );

    this.started = false;
  }

  async registerService(
    serviceName: string,
    service: FameService
  ): Promise<FameAddress> {
    if (!this.started) {
      await this.start();
    }

    const startFn = (service as any)?.start;
    if (typeof startFn === 'function') {
      await this.resolveMaybePromise(startFn.call(service));
    }

    let address: FameAddress;

    if (isFameMessageService(service)) {
      const options = this.buildServeOptions(service.capabilities);
      address = await this.serve(
        serviceName,
        this.wrapMessageHandler(service),
        options
      );
    } else if (isFameRPCService(service)) {
      const options = this.buildServeOptions(service.capabilities);
      address = await this.serveRpc(
        serviceName,
        service.handleRpcRequest.bind(service),
        options
      );
    } else {
      throw new TypeError(
        'Service must implement FameMessageService or FameRPCService'
      );
    }

    this.services.set(address.toString(), { address, service });

    if (
      (service as any)?.address === undefined &&
      this.isAddressable(service)
    ) {
      (service as any).address = address;
    }

    return address;
  }

  getLocalServices(): Map<FameAddress, FameService> {
    const entries = Array.from(this.services.values()).map(
      ({ address, service }) => [address, service] as const
    );
    return new Map(entries);
  }

  resolveByCapability(capability: unknown): FameService {
    for (const { address, service } of this.services.values()) {
      const caps = this.extractCapabilities(service);
      if (caps?.includes(capability as string)) {
        return FameServiceProxy.remoteByAddress(address, {
          invoke: this.invoke,
        });
      }
    }

    if (typeof capability === 'string') {
      const mapped = this.capabilityMap.get(capability);
      if (mapped) {
        return FameServiceProxy.remoteByAddress(mapped, {
          invoke: this.invoke,
        });
      }
    }

    throw new Error(`Capability ${String(capability)} not available`);
  }

  async resolveAddressByCapability(
    capabilities: string[]
  ): Promise<FameAddress | null> {
    for (const { address, service } of this.services.values()) {
      const caps = this.extractCapabilities(service) ?? [];
      if (capabilities.every((cap) => caps.includes(cap))) {
        return address;
      }
    }

    if (capabilities.length === 1) {
      const mapped = this.capabilityMap.get(capabilities[0]);
      if (mapped) {
        return mapped;
      }
    }

    return null;
  }

  private async registerDefaultServices(): Promise<void> {
    for (const rawConfig of this.defaultServiceConfigs) {
      if (!rawConfig || typeof rawConfig !== 'object') {
        continue;
      }

      const config = rawConfig as Record<string, unknown>;
      const name =
        typeof config.name === 'string' ? (config.name as string) : undefined;
      if (!name) {
        continue;
      }

      const service = await createResource<FameService>(
        'FameServiceFactory',
        config,
        {
          validate: false,
        }
      );

      if (!service) {
        continue;
      }

      await this.registerService(name, service);
    }
  }

  private ensureExtensionManager(): void {
    if (this.extensionManagerInitialized) {
      return;
    }

    ExtensionManager.getExtensionManager(
      'naylence.FameServiceFactory',
      'FameServiceFactory'
    );
    this.extensionManagerInitialized = true;
  }

  private extractCapabilities(service: FameService): string[] | undefined {
    if (!service) {
      return undefined;
    }
    const caps =
      (service as any).capabilities ?? (service as FameService).capabilities;
    return Array.isArray(caps) ? caps : undefined;
  }

  private isAddressable(service: FameService): boolean {
    return (
      typeof (service as any)?.address === 'undefined' ||
      (service as any)?.address === null
    );
  }

  private normalizeCapabilityMap(
    input: CapabilityMapInput
  ): Map<string, FameAddress> {
    if (!input) {
      return new Map();
    }

    if (input instanceof Map) {
      return new Map(input);
    }

    const entries = Object.entries(input).map(
      ([key, value]) => [key, value] as const
    );
    return new Map(entries);
  }

  private async resolveMaybePromise<T>(value: MaybePromise<T>): Promise<T> {
    return await value;
  }

  private wrapMessageHandler(
    service: FameMessageService
  ): Parameters<ServeProtocol>[1] {
    return async (
      envelope: FameEnvelope,
      context: FameDeliveryContext | undefined
    ) => {
      const result = await service.handleMessage(envelope, context);
      return result === undefined ? null : result;
    };
  }

  private buildServeOptions(capabilities: string[] | undefined) {
    const options: { capabilities?: string[]; pollTimeoutMs?: number } = {};
    if (capabilities && capabilities.length > 0) {
      options.capabilities = capabilities;
    }
    if (this.pollTimeoutMs !== null) {
      options.pollTimeoutMs = this.pollTimeoutMs;
    }
    return options;
  }
}
