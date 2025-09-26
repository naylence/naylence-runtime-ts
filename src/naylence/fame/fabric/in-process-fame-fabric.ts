import {
  DEFAULT_INVOKE_TIMEOUT_MILLIS,
  SINK_CAPABILITY,
  generateId,
  FameFabric,
  type DeliveryAckFrame,
  type FameAddress,
  type FameConfig,
  type FameEnvelope,
  type FameMessageHandler,
  type FameService,
  FameServiceProxy,
  isFameMessageResponse,
  type FameMessageResponse,
  type FameEnvelopeHandler,
} from 'naylence-core';

import type { NodeLike } from '../node/node-like.js';
import { NodeLikeFactory } from '../node/node-like-factory.js';
import { getLogger } from '../util/logging.js';
import { decodeFameDataPayload } from '../util/util.js';
import type { ServiceManager } from '../service/service-manager.js';
import { SinkService, isSinkService } from '../service/sink-service.js';
import {
  normalizeExtendedFameConfig,
  type ExtendedFameConfig,
} from '../config/extended-fame-config.js';

const logger = getLogger('naylence.fame.fabric.in_process');

function resolveRuntimeVersion(): string | null {
  try {
    const processRef = (globalThis as any)?.process;
    const env = processRef?.env;
    if (!env) {
      return null;
    }

    if (typeof env.NAYLENCE_RUNTIME_VERSION === 'string' && env.NAYLENCE_RUNTIME_VERSION.trim()) {
      return env.NAYLENCE_RUNTIME_VERSION.trim();
    }

    if (
      typeof env.npm_package_name === 'string' &&
      env.npm_package_name === 'naylence-runtime' &&
      typeof env.npm_package_version === 'string'
    ) {
      return env.npm_package_version;
    }
  } catch {
    // Ignore lookup failures and fall back to warning
  }

  return null;
}

function normalizeNodeConfig(config: unknown): Record<string, unknown> | null {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return null;
}

export class InProcessFameFabric extends FameFabric {
  private _currentNode: NodeLike | null;
  private _ownsNode: boolean;
  private _nodeStarted = false;
  private _fabricStarted = false;
  private readonly _config: ExtendedFameConfig | null;
  private _versionLogged = false;

  constructor(
    node?: NodeLike | null,
    config?: FameConfig | Record<string, unknown> | null,
    _capabilities?: Map<unknown, string> | Record<string, string> | null
  ) {
    super();

    this._currentNode = node ?? null;
    this._ownsNode = !node;
    this._config = config ? normalizeExtendedFameConfig(config) : null;
  }

  private logStartupVersion(): void {
    if (this._versionLogged) {
      return;
    }
    this._versionLogged = true;

    const version = resolveRuntimeVersion();
    if (version) {
      logger.info('naylence_runtime_startup', {
        version,
        fabric_type: 'in_process',
      });
    } else {
      logger.warning('naylence_runtime_version_not_found', {
        message: 'Could not determine package version',
        fabric_type: 'in_process',
      });
    }
  }

  private getRequiredNode(): NodeLike {
    if (!this._currentNode) {
      throw new Error('InProcessFameFabric has not been started yet');
    }
    return this._currentNode;
  }

  private get serviceManager(): ServiceManager {
    const node = this.getRequiredNode() as any;
    const manager: ServiceManager | undefined =
      node.serviceManager ?? node.getServiceManager?.() ?? node._serviceManager;

    if (!manager) {
      throw new Error('Node does not expose a service manager');
    }

    return manager;
  }

  override async start(): Promise<void> {
    if (this._fabricStarted) {
      return;
    }

    this.logStartupVersion();
    logger.debug('starting_fabric', { type: 'in_process' });

    if (!this._currentNode) {
      const nodeConfig = normalizeNodeConfig(this._config?.node ?? null);
      this._currentNode = await NodeLikeFactory.createNode(nodeConfig);
      this._ownsNode = true;
    }

    if (this._ownsNode && !this._nodeStarted) {
      await this.getRequiredNode().start();
      this._nodeStarted = true;
    }

    this._fabricStarted = true;
  }

  override async stop(): Promise<void> {
    if (!this._fabricStarted) {
      return;
    }

    if (this._ownsNode && this._currentNode && this._nodeStarted) {
      await this._currentNode.stop();
      this._nodeStarted = false;
    }

    this._fabricStarted = false;
  }

  get node(): NodeLike {
    return this.getRequiredNode();
  }

  override async send(
    envelope: FameEnvelope,
    timeoutMs?: number | null
  ): Promise<DeliveryAckFrame | null> {
    return this.getRequiredNode().send(
      envelope,
      undefined,
      undefined,
      undefined,
      timeoutMs ?? undefined
    );
  }

  override async invoke(
    address: FameAddress,
    method: string,
    params: Record<string, any>,
    timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MILLIS
  ): Promise<unknown> {
    return this.getRequiredNode().invoke(address, method, params, timeoutMs);
  }

  override async invokeByCapability(
    capabilities: string[],
    method: string,
    params: Record<string, any>,
    timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MILLIS
  ): Promise<unknown> {
    return this.getRequiredNode().invokeByCapability(capabilities, method, params, timeoutMs);
  }

  override async invokeStream(
    address: FameAddress,
    method: string,
    params: Record<string, any>,
    timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MILLIS
  ): Promise<AsyncIterable<unknown>> {
    return this.getRequiredNode().invokeStream(address, method, params, timeoutMs);
  }

  override async invokeByCapabilityStream(
    capabilities: string[],
    method: string,
    params: Record<string, any>,
    timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MILLIS
  ): Promise<AsyncIterable<unknown>> {
    return this.getRequiredNode().invokeByCapabilityStream(capabilities, method, params, timeoutMs);
  }

  override async serve(service: FameService, serviceName?: string | null): Promise<FameAddress> {
    const resolvedName = serviceName ?? (service as { name?: string }).name ?? null;
    if (!resolvedName) {
      throw new Error("service_name parameter not set and service doesn't define 'name' property");
    }
    return this.serviceManager.registerService(resolvedName, service);
  }

  getLocalServices(): Map<FameAddress, FameService> {
    return this.serviceManager.getLocalServices();
  }

  override resolveServiceByCapability(capability: string): FameService {
    return this.serviceManager.resolveByCapability(capability);
  }

  get sinkService(): SinkService {
    const service = this.resolveServiceByCapability(SINK_CAPABILITY);
    if (!isSinkService(service) && !(service instanceof FameServiceProxy)) {
      throw new Error(
        `Invalid service type. Expected SinkService or FameServiceProxy, actual: ${
          service?.constructor?.name ?? typeof service
        }`
      );
    }
    return service as SinkService;
  }

  async createSink(name?: string | null): Promise<FameAddress> {
    const sinkName = name?.trim() || `sink-${generateId()}`;
    return this.sinkService.createSink({ name: sinkName });
  }

  override async subscribe(
    sinkAddress: FameAddress,
    handler: FameMessageHandler,
    name?: string | null
  ): Promise<void> {
    const subscriberName = name?.trim() || `sink-subscriber-${generateId()}`;

    const decodeAndHandle: FameEnvelopeHandler = async (
      envelope: FameEnvelope
    ): Promise<FameMessageResponse | null> => {
      const frame: any = envelope.frame;
      if (!frame || frame.type !== 'Data') {
        throw new Error(
          `Invalid envelope frame type. Expected: DataFrame, actual: ${frame?.type ?? typeof frame}`
        );
      }

      const result = await handler(decodeFameDataPayload(frame));
      return isFameMessageResponse(result) ? result : null;
    };

    const subscriberAddress = await this.getRequiredNode().listen(subscriberName, decodeAndHandle);

    await this.sinkService.subscribe({
      sinkAddress: sinkAddress.toString(),
      subscriberAddress: subscriberAddress.toString(),
    });
  }
}
