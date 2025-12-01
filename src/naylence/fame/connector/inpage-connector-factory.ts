import {
  CONNECTOR_FACTORY_BASE_TYPE,
  ConnectorFactory,
  type ConnectionGrant,
} from './connector-factory.js';
import {
  InPageConnector,
  INPAGE_CONNECTOR_TYPE,
  type InPageConnectorConfig,
} from './inpage-connector.js';
import type { ConnectorConfig } from './connector-config.js';
import type { BaseAsyncConnectorConfig } from './base-async-connector.js';
import type { AuthorizationContext } from '@naylence/core';
import type { ExpressionEvaluationPolicy } from '@naylence/factory';
import {
  INPAGE_CONNECTION_GRANT_TYPE,
  inPageGrantToConnectorConfig,
  normalizeInPageConnectionGrant,
  type InPageConnectionGrant,
  type InPageConnectionGrantLike,
} from '../grants/inpage-connection-grant.js';

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

type NormalizedConfig = InPageConnectorFactoryConfig & BaseAsyncConnectorConfig;

export interface InPageConnectorFactoryConfig
  extends ConnectorConfig,
    Partial<BaseAsyncConnectorConfig> {
  type: typeof INPAGE_CONNECTOR_TYPE;
  channelName?: string;
  inboxCapacity?: number;
  localNodeId?: string;
  initialTargetNodeId?: string | '*';
}

export interface CreateInPageConnectorOptions {
  systemId?: string;
  authorization?: AuthorizationContext;
  localNodeId?: string;
  initialTargetNodeId?: string | '*';
}

class InPageConnectionGrantImpl implements InPageConnectionGrant {
  public type = INPAGE_CONNECTION_GRANT_TYPE;
  public purpose = 'connection';
  public channelName?: string;
  public inboxCapacity?: number;
  [key: string]: unknown;
}

export const FACTORY_META = {
  base: CONNECTOR_FACTORY_BASE_TYPE,
  key: INPAGE_CONNECTOR_TYPE,
} as const;

export class InPageConnectorFactory extends ConnectorFactory<
  InPageConnector,
  InPageConnectorFactoryConfig
> {
  public readonly type = INPAGE_CONNECTOR_TYPE;

  public supportedGrantTypes(): string[] {
    return [INPAGE_CONNECTION_GRANT_TYPE, INPAGE_CONNECTOR_TYPE];
  }

  public supportedGrants(): Record<string, new () => ConnectionGrant> {
    return {
      [INPAGE_CONNECTION_GRANT_TYPE]: InPageConnectionGrantImpl,
    };
  }

  public configFromGrant(
    grant: ConnectionGrant | Record<string, unknown>,
    _expressionEvaluationPolicy: ExpressionEvaluationPolicy
  ): InPageConnectorFactoryConfig {
    const normalized = normalizeInPageConnectionGrant(
      grant as InPageConnectionGrantLike
    );
    const candidate = inPageGrantToConnectorConfig(normalized);

    const config: InPageConnectorFactoryConfig = {
      type: INPAGE_CONNECTOR_TYPE,
    };

    if (candidate.channelName) {
      config.channelName = candidate.channelName;
    }

    if (candidate.inboxCapacity !== undefined) {
      config.inboxCapacity = candidate.inboxCapacity;
    }

    return config;
  }

  public grantFromConfig(
    config: InPageConnectorFactoryConfig | Record<string, unknown>,
    _expressionEvaluationPolicy: ExpressionEvaluationPolicy
  ): InPageConnectionGrant {
    const normalized = this._normalizeConfig(config);
    const raw = config as Record<string, unknown>;

    const grant: InPageConnectionGrant = {
      type: INPAGE_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
    };

    const rawChannel = raw.channelName ?? raw['channel_name'];
    if (typeof rawChannel === 'string' && rawChannel.trim().length > 0) {
      grant.channelName = normalized.channelName;
    }

    const rawInbox = raw.inboxCapacity ?? raw['inbox_capacity'];
    if (
      typeof rawInbox === 'number' &&
      Number.isFinite(rawInbox) &&
      rawInbox > 0
    ) {
      grant.inboxCapacity = normalized.inboxCapacity;
    }

    return grant;
  }

  public async create(
    config?: InPageConnectorFactoryConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<InPageConnector> {
    if (!config) {
      throw new Error('InPageConnectorFactory requires a configuration');
    }

    const normalized = this._normalizeConfig(config);
    const options = (factoryArgs[0] ?? {}) as CreateInPageConnectorOptions;
    const normalizedLocalNodeFromConfig = this._normalizeNodeId(
      normalized.localNodeId
    );
    const localNodeId =
      this._normalizeNodeId(options.localNodeId) ?? normalizedLocalNodeFromConfig;
    if (!localNodeId) {
      throw new Error(
        'InPageConnectorFactory requires a localNodeId from config or create() options'
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

    const connectorConfig: InPageConnectorConfig = {
      type: INPAGE_CONNECTOR_TYPE,
      channelName,
      inboxCapacity,
      localNodeId,
      initialTargetNodeId: resolvedTarget,
    };

    const connector = new InPageConnector(connectorConfig, baseConfig);

    if (options.authorization) {
      connector.authorizationContext = options.authorization;
    }

    return connector;
  }

  private _normalizeConfig(
    config: InPageConnectorFactoryConfig | Record<string, unknown>
  ): NormalizedConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration must be an object');
    }

    const candidate = config as InPageConnectorFactoryConfig &
      Record<string, unknown>;

    if (candidate.type !== INPAGE_CONNECTOR_TYPE) {
      throw new Error(
        `InPageConnectorFactory only supports ${INPAGE_CONNECTOR_TYPE} config`
      );
    }

    const normalized: Partial<NormalizedConfig> = {
      type: INPAGE_CONNECTOR_TYPE,
    };

    const channel = candidate.channelName;
    if (typeof channel === 'string' && channel.trim().length > 0) {
      normalized.channelName = channel.trim();
    }

    const legacyChannel = candidate['channel_name'];
    if (!normalized.channelName && typeof legacyChannel === 'string') {
      const trimmed = legacyChannel.trim();
      if (trimmed.length > 0) {
        normalized.channelName = trimmed;
      }
    }

    const capacity = candidate.inboxCapacity ?? candidate['inbox_capacity'];
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

    const initialTargetNodeId =
      candidate.initialTargetNodeId ?? candidate['initial_target_node_id'];
    const normalizedTarget = this._normalizeTargetNodeId(initialTargetNodeId);
    if (normalizedTarget) {
      normalized.initialTargetNodeId = normalizedTarget;
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

  private _normalizeTargetNodeId(
    value: unknown
  ): string | '*' | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (value === '*') {
      return '*';
    }

    return this._normalizeNodeId(value) ?? undefined;
  }
}

export default InPageConnectorFactory;
