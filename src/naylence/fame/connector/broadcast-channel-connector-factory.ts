import {
  CONNECTOR_FACTORY_BASE_TYPE,
  ConnectorFactory,
  type ConnectionGrant,
} from './connector-factory.js';
import {
  BroadcastChannelConnector,
  BROADCAST_CHANNEL_CONNECTOR_TYPE,
  type BroadcastChannelConnectorConfig,
} from './broadcast-channel-connector.js';
import type { ConnectorConfig } from './connector-config.js';
import type { BaseAsyncConnectorConfig } from './base-async-connector.js';
import type { AuthorizationContext } from '@naylence/core';
import {
  BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
  broadcastChannelGrantToConnectorConfig,
  normalizeBroadcastChannelConnectionGrant,
  type BroadcastChannelConnectionGrant,
  type BroadcastChannelConnectionGrantLike,
} from '../grants/broadcast-channel-connection-grant.js';

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

type NormalizedConfig = BroadcastChannelConnectorFactoryConfig &
  BaseAsyncConnectorConfig;

export interface BroadcastChannelConnectorFactoryConfig
  extends ConnectorConfig,
    Partial<BaseAsyncConnectorConfig> {
  type: typeof BROADCAST_CHANNEL_CONNECTOR_TYPE;
  channelName?: string;
  inboxCapacity?: number;
  localNodeId?: string;
  initialTargetNodeId?: string | '*';
  passive?: boolean;
}

export interface CreateBroadcastChannelConnectorOptions {
  authorization?: AuthorizationContext;
  localNodeId?: string;
  initialTargetNodeId?: string | '*';
}

class BroadcastChannelConnectionGrantImpl
  implements BroadcastChannelConnectionGrant
{
  public type = BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE;
  public purpose = 'connection';
  public channelName?: string;
  public inboxCapacity?: number;
  public initialWindow?: number;
  [key: string]: unknown;
}

export const FACTORY_META = {
  base: CONNECTOR_FACTORY_BASE_TYPE,
  key: BROADCAST_CHANNEL_CONNECTOR_TYPE,
} as const;

export class BroadcastChannelConnectorFactory extends ConnectorFactory<
  BroadcastChannelConnector,
  BroadcastChannelConnectorFactoryConfig
> {
  public readonly type = BROADCAST_CHANNEL_CONNECTOR_TYPE;

  public supportedGrantTypes(): string[] {
    return [
      BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
      BROADCAST_CHANNEL_CONNECTOR_TYPE,
    ];
  }

  public supportedGrants(): Record<string, new () => ConnectionGrant> {
    return {
      [BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE]:
        BroadcastChannelConnectionGrantImpl,
    };
  }

  public configFromGrant(
    grant: ConnectionGrant | Record<string, unknown>
  ): BroadcastChannelConnectorFactoryConfig {
    const record = (grant ?? {}) as BroadcastChannelConnectionGrantLike;

    if (record.type === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE) {
      const connectorConfig = broadcastChannelGrantToConnectorConfig(record);
      return {
        type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
        channelName: connectorConfig.channelName,
        inboxCapacity: connectorConfig.inboxCapacity,
        initialWindow: connectorConfig.initialWindow,
      } satisfies BroadcastChannelConnectorFactoryConfig;
    }

    const config: BroadcastChannelConnectorFactoryConfig = {
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
    };

    const channelCandidate =
      record.channelName ?? (record as Record<string, unknown>)['channel_name'];
    if (
      typeof channelCandidate === 'string' &&
      channelCandidate.trim().length > 0
    ) {
      config.channelName = channelCandidate.trim();
    }

    const inboxCandidate =
      record.inboxCapacity ??
      (record as Record<string, unknown>)['inbox_capacity'];
    if (
      typeof inboxCandidate === 'number' &&
      Number.isFinite(inboxCandidate) &&
      inboxCandidate > 0
    ) {
      config.inboxCapacity = Math.floor(inboxCandidate);
    }

    return config;
  }

  public grantFromConfig(
    config: BroadcastChannelConnectorFactoryConfig | Record<string, unknown>
  ): ConnectionGrant {
    const normalizedConfig = this._normalizeConfig(config);
    const grant = normalizeBroadcastChannelConnectionGrant({
      type: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
      channelName: normalizedConfig.channelName,
      inboxCapacity: normalizedConfig.inboxCapacity,
      initialWindow: normalizedConfig.initialWindow,
    });

    return grant;
  }

  public async create(
    config?:
      | BroadcastChannelConnectorFactoryConfig
      | Record<string, unknown>
      | null,
    ...factoryArgs: unknown[]
  ): Promise<BroadcastChannelConnector> {
    if (!config) {
      throw new Error(
        'BroadcastChannelConnectorFactory requires a configuration'
      );
    }

    const normalized = this._normalizeConfig(config);
    const options = (factoryArgs[0] ??
      {}) as CreateBroadcastChannelConnectorOptions;
    const normalizedLocalNodeFromConfig = this._normalizeNodeId(
      normalized.localNodeId
    );
    const localNodeId =
      this._normalizeNodeId(options.localNodeId) ??
      normalizedLocalNodeFromConfig;
    if (!localNodeId) {
      throw new Error(
        'BroadcastChannelConnectorFactory requires a localNodeId from config or create() options'
      );
    }

    const channelName = normalized.channelName ?? DEFAULT_CHANNEL;
    const inboxCapacity = normalized.inboxCapacity ?? DEFAULT_INBOX_CAPACITY;
    const targetFromOptions = this._normalizeTargetNodeId(
      options.initialTargetNodeId
    );
    const targetFromConfig = this._normalizeTargetNodeId(
      normalized.initialTargetNodeId
    );
    const resolvedTarget = targetFromOptions ?? targetFromConfig ?? '*';

    const baseConfig: BaseAsyncConnectorConfig = {
      drainTimeout: normalized.drainTimeout,
      flowControl: normalized.flowControl,
      initialWindow: normalized.initialWindow,
      maxQueueSize: normalized.maxQueueSize,
      metricsEmitter: normalized.metricsEmitter,
      shutdownTimeouts: normalized.shutdownTimeouts,
      taskSpawner: normalized.taskSpawner,
      authorizationContext: normalized.authorizationContext,
    };

    const connectorConfig: BroadcastChannelConnectorConfig = {
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
      channelName,
      inboxCapacity,
      localNodeId,
      initialTargetNodeId: resolvedTarget,
      passive: normalized.passive,
    };

    const connector = new BroadcastChannelConnector(
      connectorConfig,
      baseConfig
    );

    if (options.authorization) {
      connector.authorizationContext = options.authorization;
    }

    return connector;
  }

  private _normalizeConfig(
    config: BroadcastChannelConnectorFactoryConfig | Record<string, unknown>
  ): NormalizedConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration must be an object');
    }

    const candidate = config as BroadcastChannelConnectorFactoryConfig &
      Record<string, unknown>;

    if (candidate.type !== BROADCAST_CHANNEL_CONNECTOR_TYPE) {
      throw new Error(
        `BroadcastChannelConnectorFactory only supports ${BROADCAST_CHANNEL_CONNECTOR_TYPE} config`
      );
    }

    const normalized: Partial<NormalizedConfig> = {
      type: BROADCAST_CHANNEL_CONNECTOR_TYPE,
    };

    const channel = candidate.channelName ?? candidate['channel_name'];
    if (typeof channel === 'string' && channel.trim().length > 0) {
      normalized.channelName = channel.trim();
    }

    const capacity = candidate.inboxCapacity ?? candidate['inbox_capacity'];
    const initialTargetNodeId =
      candidate.initialTargetNodeId ?? candidate['initial_target_node_id'];
    const normalizedTarget = this._normalizeTargetNodeId(initialTargetNodeId);
    if (normalizedTarget) {
      normalized.initialTargetNodeId = normalizedTarget;
    }
    if (
      typeof capacity === 'number' &&
      Number.isFinite(capacity) &&
      capacity > 0
    ) {
      normalized.inboxCapacity = Math.floor(capacity);
    }

    const localNodeId = candidate.localNodeId ?? candidate['local_node_id'];
    const normalizedLocalNodeId = this._normalizeNodeId(localNodeId);
    if (normalizedLocalNodeId) {
      normalized.localNodeId = normalizedLocalNodeId;
    }

    if (typeof candidate.passive === 'boolean') {
      normalized.passive = candidate.passive;
    }

    if (typeof candidate.flowControl === 'boolean') {
      normalized.flowControl = candidate.flowControl;
    }

    const maxQueueSize = candidate.maxQueueSize ?? candidate['max_queue_size'];
    if (
      typeof maxQueueSize === 'number' &&
      Number.isFinite(maxQueueSize) &&
      maxQueueSize > 0
    ) {
      normalized.maxQueueSize = Math.floor(maxQueueSize);
    }

    const initialWindow =
      candidate.initialWindow ?? candidate['initial_window'];
    if (
      typeof initialWindow === 'number' &&
      Number.isFinite(initialWindow) &&
      initialWindow > 0
    ) {
      normalized.initialWindow = Math.floor(initialWindow);
    }

    const drainTimeout = candidate.drainTimeout ?? candidate['drain_timeout'];
    if (
      typeof drainTimeout === 'number' &&
      Number.isFinite(drainTimeout) &&
      drainTimeout >= 0
    ) {
      normalized.drainTimeout = drainTimeout;
    }

    if (candidate.metricsEmitter !== undefined) {
      normalized.metricsEmitter = candidate.metricsEmitter as
        | BaseAsyncConnectorConfig['metricsEmitter']
        | undefined;
    }

    if (candidate.taskSpawner !== undefined) {
      normalized.taskSpawner = candidate.taskSpawner as
        | BaseAsyncConnectorConfig['taskSpawner']
        | undefined;
    }

    if (candidate.shutdownTimeouts !== undefined) {
      normalized.shutdownTimeouts = candidate.shutdownTimeouts as
        | BaseAsyncConnectorConfig['shutdownTimeouts']
        | undefined;
    }

    if (candidate.authorizationContext !== undefined) {
      normalized.authorizationContext = candidate.authorizationContext as
        | AuthorizationContext
        | undefined;
    }

    normalized.channelName = normalized.channelName ?? DEFAULT_CHANNEL;
    normalized.inboxCapacity =
      normalized.inboxCapacity ?? DEFAULT_INBOX_CAPACITY;

    return normalized as NormalizedConfig;
  }

  private _normalizeNodeId(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private _normalizeTargetNodeId(value: unknown): string | '*' | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (value === '*') {
      return '*';
    }

    return this._normalizeNodeId(value) ?? undefined;
  }
}

export default BroadcastChannelConnectorFactory;
