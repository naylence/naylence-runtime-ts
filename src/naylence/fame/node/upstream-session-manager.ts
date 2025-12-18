import { ConnectorFactory } from '../connector/connector-factory.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { AsyncEvent } from '../util/async-event.js';
import { getLogger } from '../util/logging.js';
import {
  ConnectorState,
  DeliveryAckFrame,
  DeliveryOriginType,
  FameConnector,
  FameDeliveryContext,
  FameEnvelope,
  FameEnvelopeHandler,
  FameEnvelopeWith,
  FameFabric,
  NodeAttachAckFrame,
  NodeHeartbeatAckFrame,
  NodeHeartbeatFrame,
  NodeWelcomeFrame,
  SecurityContext,
  generateId,
} from '@naylence/core';
import {
  FameConnectError,
  FameMessageTooLarge,
  FameTransportClose,
} from '../errors/errors.js';
import type { AdmissionClient } from './admission/admission-client.js';
import type { ConnectionRetryPolicy } from './connection-retry-policy.js';
import type {
  NodeAttachClient,
  AttachInfo,
} from './admission/node-attach-client.js';
import type { NodeLike } from './node-like.js';
import type { SessionManager } from './session-manager.js';
import { TaskCancelledError, SpawnedTask } from '../util/task-types.js';
import type { FameAddress } from '@naylence/core';
import { FameResponseType } from '@naylence/core';
import { withLegacySnakeCaseKeys } from '../util/util.js';
import {
  BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
  normalizeBroadcastChannelConnectionGrant,
  type BroadcastChannelConnectionGrantLike,
} from '../grants/broadcast-channel-connection-grant.js';
import { BROADCAST_CHANNEL_CONNECTOR_TYPE } from '../connector/broadcast-channel-connector.js';

const logger = getLogger('naylence.fame.node.upstream_session_manager');

interface EpochCallback {
  (epoch: string): Promise<any>;
}

interface AttachCallback {
  (info: AttachInfo, connector: FameConnector): Promise<any>;
}

interface WelcomeCallback {
  (frame: NodeWelcomeFrame): Promise<any>;
}

interface UpstreamSessionManagerOptions {
  node: NodeLike;
  attachClient: NodeAttachClient;
  requestedLogicals: string[];
  outboundOriginType: DeliveryOriginType;
  inboundOriginType: DeliveryOriginType;
  inboundHandler: FameEnvelopeHandler;
  onWelcome: WelcomeCallback;
  onAttach: AttachCallback;
  onEpochChange?: EpochCallback;
  admissionClient?: AdmissionClient | null;
  retryPolicy?: ConnectionRetryPolicy | null;
}

type UpstreamSessionManagerOptionsInput = UpstreamSessionManagerOptions & {
  node?: NodeLike;
  attach_client?: NodeAttachClient;
  requested_logicals?: unknown;
  outbound_origin_type?: DeliveryOriginType | string;
  inbound_origin_type?: DeliveryOriginType | string;
  inbound_handler?: FameEnvelopeHandler;
  on_welcome?: WelcomeCallback;
  on_attach?: AttachCallback;
  on_epoch_change?: EpochCallback;
  admission_client?: AdmissionClient | null;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function pickOption<T>(
  record: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const value = record[key] as T;
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter(
    (entry): entry is string => typeof entry === 'string'
  );
  return [...filtered];
}

function resolveOriginType(value: unknown, label: string): DeliveryOriginType {
  if (value === undefined || value === null) {
    throw new Error(`UpstreamSessionManager requires a ${label} option`);
  }
  if (typeof value === 'string') {
    return value as DeliveryOriginType;
  }
  return value as DeliveryOriginType;
}

function ensureCallback<T extends (...args: any[]) => any>(
  value: unknown,
  label: string
): T {
  if (typeof value !== 'function') {
    throw new Error(`UpstreamSessionManager requires a ${label} callback`);
  }
  return value as T;
}

function normalizeOptions(
  options: UpstreamSessionManagerOptionsInput
): UpstreamSessionManagerOptions {
  if (!isPlainRecord(options)) {
    throw new Error('UpstreamSessionManager options must be an object');
  }

  const record = options as Record<string, unknown>;

  const node = pickOption<NodeLike>(record, 'node');
  if (!node) {
    throw new Error('UpstreamSessionManager requires a node option');
  }

  const attachClient = pickOption<NodeAttachClient>(
    record,
    'attachClient',
    'attach_client'
  );
  if (!attachClient) {
    throw new Error('UpstreamSessionManager requires an attachClient option');
  }

  const requestedLogicalsValue = pickOption<unknown>(
    record,
    'requestedLogicals',
    'requested_logicals'
  );
  const requestedLogicals = coerceStringArray(requestedLogicalsValue) ?? [];

  const outboundOriginType = resolveOriginType(
    pickOption<DeliveryOriginType | string>(
      record,
      'outboundOriginType',
      'outbound_origin_type'
    ),
    'outboundOriginType'
  );

  const inboundOriginType = resolveOriginType(
    pickOption<DeliveryOriginType | string>(
      record,
      'inboundOriginType',
      'inbound_origin_type'
    ),
    'inboundOriginType'
  );

  const inboundHandler = pickOption<FameEnvelopeHandler>(
    record,
    'inboundHandler',
    'inbound_handler'
  );
  const validatedInboundHandler = ensureCallback<FameEnvelopeHandler>(
    inboundHandler,
    'inboundHandler'
  );

  const onWelcome = pickOption<WelcomeCallback>(
    record,
    'onWelcome',
    'on_welcome'
  );
  const validatedOnWelcome = ensureCallback<WelcomeCallback>(
    onWelcome,
    'onWelcome'
  );

  const onAttach = pickOption<AttachCallback>(record, 'onAttach', 'on_attach');
  const validatedOnAttach = ensureCallback<AttachCallback>(
    onAttach,
    'onAttach'
  );

  const onEpochChangeValue = pickOption<EpochCallback>(
    record,
    'onEpochChange',
    'on_epoch_change'
  );
  const onEpochChange =
    typeof onEpochChangeValue === 'function' ? onEpochChangeValue : undefined;

  const admissionClient = pickOption<AdmissionClient | null>(
    record,
    'admissionClient',
    'admission_client'
  );

  const retryPolicy = pickOption<ConnectionRetryPolicy | null>(
    record,
    'retryPolicy',
    'retry_policy'
  );

  return {
    node,
    attachClient,
    requestedLogicals,
    outboundOriginType,
    inboundOriginType,
    inboundHandler: validatedInboundHandler,
    onWelcome: validatedOnWelcome,
    onAttach: validatedOnAttach,
    onEpochChange,
    admissionClient: admissionClient ?? undefined,
    retryPolicy: retryPolicy ?? undefined,
  };
}

export class UpstreamSessionManager
  extends TaskSpawner
  implements SessionManager
{
  public static readonly HEARTBEAT_INTERVAL = 15; // seconds
  public static readonly HEARTBEAT_GRACE = 2.0;
  public static readonly JWT_REFRESH_SAFETY = 60; // seconds
  public static readonly TX_QUEUE_MAX = 512;
  public static readonly BACKOFF_INITIAL = 1; // seconds
  public static readonly BACKOFF_CAP = 30; // seconds

  private readonly node: NodeLike;
  private readonly requestedLogicals: string[];
  private readonly outboundOriginType: DeliveryOriginType;
  private readonly inboundOriginType: DeliveryOriginType;
  private readonly onWelcome: WelcomeCallback;
  private readonly onAttach: AttachCallback;
  private readonly onEpochChange: EpochCallback | undefined;
  private readonly admissionClient: AdmissionClient | null;
  private readonly attachClient: NodeAttachClient;
  private readonly wrappedHandler: FameEnvelopeHandler;

  private readonly readyEvent = new AsyncEvent();
  private readonly stopEvent = new AsyncEvent();
  private readonly wakeEvent = new AsyncEvent();
  private readonly queueEvent = new AsyncEvent();
  private currentStopSubtasks: AsyncEvent | null = null;

  private readonly messageQueue: FameEnvelope[] = [];

  private fsmTask: SpawnedTask<void> | null = null;
  private connector: FameConnector | null = null;
  private targetSystemId: string | null = null;
  private lastHeartbeatAckTime: number | null = null;
  private lastSeenEpoch: string | null = null;
  private hadSuccessfulAttach = false;
  private lastConnectorState: ConnectorState | null = null;
  private connectEpoch = 0;
  private initialAttempts = 0;
  private readonly connectionRetryPolicy: ConnectionRetryPolicy | null;
  private _visibilityHandler: (() => void) | null = null;

  constructor(optionsInput: UpstreamSessionManagerOptionsInput) {
    super();
    const options = normalizeOptions(optionsInput);
    this.node = options.node;
    this.attachClient = options.attachClient;
    this.requestedLogicals = [...options.requestedLogicals];
    this.outboundOriginType = options.outboundOriginType;
    this.inboundOriginType = options.inboundOriginType;
    this.onWelcome = options.onWelcome;
    this.onAttach = options.onAttach;
    this.onEpochChange = options.onEpochChange;
    this.admissionClient =
      options.admissionClient ?? options.node.admissionClient;
    this.wrappedHandler = this.makeHeartbeatEnabledHandler(
      options.inboundHandler
    );

    // Store the connection retry policy (can be null, in which case default behavior applies)
    this.connectionRetryPolicy = options.retryPolicy ?? null;

    logger.debug('created_upstream_session_manager', {
      target_system_id: this.targetSystemId,
      has_retry_policy: this.connectionRetryPolicy !== null,
    });
  }

  get systemId(): string | null {
    return this.targetSystemId;
  }

  private setupVisibilityListener(): void {
    logger.debug('setup_visibility_listener_called', {
      has_document: typeof document !== 'undefined',
    });
    if (typeof document !== 'undefined' && document.addEventListener) {
      this._visibilityHandler = () => {
        logger.debug('visibility_change_event_fired', {
          state: document.visibilityState,
        });
        if (document.visibilityState === 'visible') {
          logger.debug('visibility_change_detected_waking_up');
          this.wakeEvent.set();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    } else {
      logger.debug('setup_visibility_listener_skipped_no_document');
    }
  }

  private teardownVisibilityListener(): void {
    if (
      this._visibilityHandler &&
      typeof document !== 'undefined' &&
      document.removeEventListener
    ) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  async start(options: { waitUntilReady?: boolean } = {}): Promise<void> {
    const { waitUntilReady = true } = options;
    if (this.fsmTask) {
      return;
    }

    this.stopEvent.clear();
    this.readyEvent.clear();
    this.wakeEvent.clear();
    this.setupVisibilityListener();

    const taskName = `upstream-fsm-${this.connectEpoch}`;
    this.fsmTask = this.spawn(() => this.fsmLoop(), { name: taskName });

    if (!waitUntilReady) {
      return;
    }

    const readyPromise = this.readyEvent.wait();
    await Promise.race([readyPromise, this.fsmTask.promise]);

    if (!this.readyEvent.isSet()) {
      if (this.fsmTask) {
        await this.fsmTask.promise;
      }
      throw new FameConnectError('Upstream session manager failed to attach');
    }

    logger.debug('upstream_session_manager_started');
  }

  getActiveConnector(): FameConnector | null {
    return this.connector;
  }

  async stop(): Promise<void> {
    logger.debug('upstream_session_manager_stopping');
    this.teardownVisibilityListener();
    this.stopEvent.set();
    this.currentStopSubtasks?.set();

    if (this.fsmTask) {
      this.fsmTask.cancel();
      try {
        await this.fsmTask.promise;
      } catch (error) {
        if (!(error instanceof TaskCancelledError)) {
          logger.debug('fsm_task_stopped_with_error', {
            error: (error as Error).message,
          });
        }
      }
      this.fsmTask = null;
    }

    if (this.connector) {
      await this.connector.stop().catch((error: unknown) => {
        logger.debug('connector_stop_error', {
          error: (error as Error).message,
        });
      });
      this.connector = null;
    }

    logger.debug('upstream_session_manager_stopped');
  }

  async send(envelope: FameEnvelope): Promise<void> {
    if (this.messageQueue.length >= UpstreamSessionManager.TX_QUEUE_MAX) {
      throw new Error('Upstream message queue is full');
    }
    this.messageQueue.push(envelope);
    this.queueEvent.set();
  }

  isReady(): boolean {
    return this.readyEvent.isSet();
  }

  async awaitReady(timeoutMs?: number): Promise<void> {
    if (this.isReady()) {
      return;
    }

    const readyPromise = this.readyEvent.wait();
    if (timeoutMs === undefined) {
      await readyPromise;
      return;
    }

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(
        () =>
          reject(new FameConnectError('Timed out waiting for upstream ready')),
        timeoutMs
      );
    });

    await Promise.race([readyPromise, timeoutPromise]);
  }

  private async fsmLoop(): Promise<void> {
    let delay = UpstreamSessionManager.BACKOFF_INITIAL;
    this.initialAttempts = 0;

    while (!this.stopEvent.isSet()) {
      const startTime = Date.now();
      this.initialAttempts += 1;

      try {
        await this.connectCycle();
        delay = UpstreamSessionManager.BACKOFF_INITIAL;
        this.initialAttempts = 0; // Reset on success
      } catch (error) {
        // Reset backoff if the connection was alive for more than 10 seconds
        if (Date.now() - startTime > 10000) {
          delay = UpstreamSessionManager.BACKOFF_INITIAL;
        }

        if (error instanceof TaskCancelledError) {
          throw error;
        }

        // Determine if we should fail-fast or retry
        const shouldFailFast = this.shouldFailFastOnError(error);

        if (
          error instanceof FameTransportClose ||
          error instanceof FameConnectError
        ) {
          logger.warning('upstream_link_closed', {
            error: error.message,
            will_retry: !shouldFailFast,
            attempt: this.initialAttempts,
            has_retry_policy: this.connectionRetryPolicy !== null,
          });
          if (shouldFailFast && error instanceof FameConnectError) {
            throw error;
          }
        } else {
          const err = error as Error;
          if (err.name === 'OAuth2PkceRedirectInitiatedError') {
            logger.info('upstream_link_redirecting', {
              error: err.message,
              will_retry: true,
            });
          } else {
            logger.warning('upstream_link_closed', {
              error: err.message,
              will_retry: !shouldFailFast,
              attempt: this.initialAttempts,
              has_retry_policy: this.connectionRetryPolicy !== null,
              exc_info: true,
            });
          }
          if (shouldFailFast) {
            throw error;
          }
        }

        delay = await this.applyBackoff(delay);
      }
    }
  }

  /**
   * Determine whether to fail immediately or continue retrying.
   * Returns true if we should throw the error instead of retrying.
   */
  private shouldFailFastOnError(error: unknown): boolean {
    // If no policy is configured, use legacy behavior (fail-fast after first attempt)
    if (!this.connectionRetryPolicy) {
      // After first successful attach, always retry (existing behavior)
      if (this.hadSuccessfulAttach) {
        return false;
      }
      // Without a policy, fail on first error
      return true;
    }

    // Delegate decision to the policy
    const shouldRetry = this.connectionRetryPolicy.shouldRetry({
      hadSuccessfulAttach: this.hadSuccessfulAttach,
      attemptNumber: this.initialAttempts,
      error,
    });

    return !shouldRetry;
  }

  private async applyBackoff(delay: number): Promise<number> {
    const jitter = Math.random() * delay;
    const wasWoken = await this.sleepWithStop(delay + jitter);

    // If sleep was interrupted by visibility change (user returned to tab),
    // reset backoff to initial delay for immediate retry with fresh backoff
    if (wasWoken) {
      logger.debug('backoff_reset_on_visibility_change', {
        previous_delay: delay,
        new_delay: UpstreamSessionManager.BACKOFF_INITIAL,
      });
      return UpstreamSessionManager.BACKOFF_INITIAL;
    }

    return Math.min(delay * 2, UpstreamSessionManager.BACKOFF_CAP);
  }

  /**
   * Sleep for the specified duration, but can be interrupted by stop or wake events.
   * @returns true if interrupted by wake event (e.g., visibility change), false otherwise
   */
  private async sleepWithStop(delaySeconds: number): Promise<boolean> {
    if (delaySeconds <= 0) {
      return false;
    }

    // Check if wake event is already set (e.g., visibility just changed)
    if (this.wakeEvent.isSet()) {
      this.wakeEvent.clear();
      logger.debug('sleep_skipped_wake_event_pending');
      return true;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const sleepPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timeout = undefined;
        resolve();
      }, delaySeconds * 1000);
    });

    await Promise.race([
      sleepPromise,
      this.stopEvent.wait(),
      this.wakeEvent.wait(),
    ]);

    const wasWoken = this.wakeEvent.isSet();
    if (wasWoken) {
      logger.debug('sleep_interrupted_by_wake_event');
      this.wakeEvent.clear();
    }

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    return wasWoken;
  }

  private getNodeAttachGrant(
    connectionGrants: Array<Record<string, any>> | undefined
  ): Record<string, any> | null {
    if (!connectionGrants) {
      return null;
    }
    for (const grant of connectionGrants) {
      if (grant?.purpose === 'node.attach') {
        return grant;
      }
    }
    return null;
  }

  private waitEvent(event: AsyncEvent, signal?: AbortSignal): Promise<void> {
    return signal ? event.wait({ signal }) : event.wait();
  }

  private _getLocalNodeId(): string {
    const normalized = this._normalizeNodeId(this.node.provisionalId);

    if (!normalized) {
      throw new Error(
        'UpstreamSessionManager requires node with a stable identifier'
      );
    }

    return normalized;
  }

  private _normalizeNodeId(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async connectCycle(): Promise<void> {
    if (!this.admissionClient) {
      throw new FameConnectError(
        'Admission client is required to attach upstream'
      );
    }

    this.connectEpoch += 1;

    const welcome = await this.admissionClient.hello(
      this.node.provisionalId,
      generateId(),
      this.requestedLogicals
    );

    const connectionGrants = welcome.frame.connectionGrants as
      | Array<Record<string, any>>
      | undefined;
    if (!connectionGrants?.length) {
      throw new Error('Welcome frame missing connection grants');
    }

    const grant = this.getNodeAttachGrant(connectionGrants);
    if (!grant) {
      throw new Error('Welcome frame missing node attach grant');
    }

    const cryptoProvider = this.node.cryptoProvider; //getCryptoProvider();

    if (welcome.frame.assignedPath && cryptoProvider?.prepareForAttach) {
      cryptoProvider.prepareForAttach(
        welcome.frame.systemId,
        welcome.frame.assignedPath,
        welcome.frame.acceptedLogicals ?? []
      );
    }

    await this.onWelcome(welcome.frame);

    const connector = await ConnectorFactory.createConnector(grant, {
      systemId: welcome.frame.systemId,
      localNodeId: this._getLocalNodeId(),
      initialTargetNodeId: '*',
    });

    await connector.start(this.wrappedHandler);
    this.connector = connector;
    const callbackGrants = this.node.gatherSupportedCallbackGrants();

    logger.debug('callback_grants_before_augmentation', {
      count: callbackGrants.length,
      types: callbackGrants.map((g) => g.type),
    });

    // Check if we should create a broadcast callback grant before processing connection grants
    // This prevents adding duplicate broadcast grants
    const shouldAddBroadcastGrant = this.shouldAdvertiseBroadcastGrant(
      grant,
      callbackGrants
    );
    const broadcastCallbackGrant = shouldAddBroadcastGrant
      ? this.createBroadcastCallbackGrant(grant)
      : null;

    logger.debug('broadcast_callback_grant_check', {
      should_add: shouldAddBroadcastGrant,
      grant_created: !!broadcastCallbackGrant,
    });

    // Include admission client's connection grants as callback grants
    // This ensures DirectAdmissionClient grants are available for grant selection
    if (
      welcome.frame.connectionGrants &&
      Array.isArray(welcome.frame.connectionGrants)
    ) {
      for (const grant of welcome.frame.connectionGrants) {
        if (grant && typeof grant === 'object') {
          const grantType = (grant as Record<string, unknown>).type;
          if (
            grantType === 'WebSocketConnectionGrant' ||
            grantType === 'HttpConnectionGrant'
          ) {
            continue;
          }

          // Avoid duplicates by checking if grant already exists
          const isDuplicate = callbackGrants.some(
            (existing) => JSON.stringify(existing) === JSON.stringify(grant)
          );
          if (!isDuplicate) {
            callbackGrants.push(grant);
            logger.debug('added_connection_grant_as_callback', {
              type: (grant as Record<string, unknown>).type,
            });
          } else {
            logger.debug('skipped_duplicate_connection_grant', {
              type: (grant as Record<string, unknown>).type,
            });
          }
        }
      }
    }

    // Add broadcast grant after connection grants to ensure we don't duplicate
    // any broadcast grants that may have been in connectionGrants
    if (
      broadcastCallbackGrant &&
      this.shouldAdvertiseBroadcastGrant(grant, callbackGrants)
    ) {
      callbackGrants.push(broadcastCallbackGrant);
      logger.debug('added_broadcast_callback_grant');
    } else if (broadcastCallbackGrant) {
      logger.debug('skipped_duplicate_broadcast_callback_grant');
    }

    logger.debug('callback_grants_after_augmentation', {
      count: callbackGrants.length,
      types: callbackGrants.map((g) => g.type),
    });
    const attachInfo = await this.attachClient.attach(
      this.node,
      this.outboundOriginType,
      connector,
      welcome.frame,
      this.wrappedHandler,
      this.getKeys() ?? undefined,
      callbackGrants
    );

    this.targetSystemId = attachInfo.targetSystemId ?? null;

    if (this.targetSystemId) {
      const targetAware = connector as {
        setTargetNodeId?: (nodeId: string) => void;
      };
      if (typeof targetAware.setTargetNodeId === 'function') {
        try {
          targetAware.setTargetNodeId(this.targetSystemId);
        } catch (error) {
          logger.warning('broadcast_channel_target_apply_failed', {
            error: error instanceof Error ? error.message : String(error),
            target_node_id: this.targetSystemId,
          });
        }
      }
    }

    await this.onAttach(attachInfo, connector);

    // Close the admission client immediately after attach completes
    // This releases HTTP keep-alive connections (Node.js fetch/undici requires explicit cleanup)
    if (this.admissionClient) {
      await this.admissionClient.close();
    }

    const epoch = attachInfo.routingEpoch;
    if (epoch && epoch !== this.lastSeenEpoch) {
      this.lastSeenEpoch = epoch;
      if (this.onEpochChange) {
        this.spawn(() => this.onEpochChange!(epoch), {
          name: `epoch-change-${epoch}`,
        });
      } else {
        logger.warning('parent_epoch_changed', { epoch });
      }
    }

    if (!this.readyEvent.isSet()) {
      this.readyEvent.set();
    }

    if (this.messageQueue.length > 0) {
      logger.debug('flushing_buffered_frames', {
        queue_size: this.messageQueue.length,
      });
      this.queueEvent.set();
    }

    const stopSubtasks = new AsyncEvent();
    this.currentStopSubtasks = stopSubtasks;

    const heartbeatTask = this.spawn(
      (signal) => this.heartbeatLoop(connector, stopSubtasks, signal),
      {
        name: `upstream-heartbeat-${this.connectEpoch}`,
      }
    );
    const messagePumpTask = this.spawn(
      (signal) => this.messagePumpLoop(connector, stopSubtasks, signal),
      {
        name: `message-pump-${this.connectEpoch}`,
      }
    );
    const expiryGuardTask = this.spawn(
      (signal) =>
        this.expiryGuard(connector, welcome, attachInfo, stopSubtasks, signal),
      {
        name: `expiry-guard-${this.connectEpoch}`,
      }
    );

    if (this.hadSuccessfulAttach) {
      logger.debug('reconnected_to_upstream', {
        attach_expires_at: attachInfo.attachExpiresAt?.toISOString?.() ?? null,
      });
    } else {
      logger.debug('connected_to_upstream', {
        attach_expires_at: attachInfo.attachExpiresAt?.toISOString?.() ?? null,
      });
    }

    this.hadSuccessfulAttach = true;

    const tasks = [heartbeatTask, messagePumpTask, expiryGuardTask];
    let failure: Error | null = null;

    try {
      await this.waitForFailureOrStop(tasks, stopSubtasks);
    } catch (error) {
      failure = error as Error;
    } finally {
      stopSubtasks.set();
      this.currentStopSubtasks = null;
      await Promise.allSettled(tasks.map((task) => task.promise));
      if (this.connector) {
        logger.debug('upstream_stopping_old_connector', {
          connect_epoch: this.connectEpoch,
          target_system_id: this.targetSystemId,
          timestamp: new Date().toISOString(),
        });
        await this.connector.stop().catch((err) => {
          logger.warning('upstream_connector_stop_error', {
            connect_epoch: this.connectEpoch,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        logger.debug('upstream_old_connector_stopped', {
          connect_epoch: this.connectEpoch,
          target_system_id: this.targetSystemId,
          timestamp: new Date().toISOString(),
        });
        this.connector = null;
      }
    }

    if (failure) {
      throw failure;
    }
  }

  private shouldAdvertiseBroadcastGrant(
    grant: Record<string, any>,
    callbackGrants: Record<string, any>[]
  ): boolean {
    const inboundType = typeof grant.type === 'string' ? grant.type : '';
    const connectorType = (grant as Record<string, unknown>)['connectorType'];

    const matchesBroadcast =
      inboundType === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE ||
      inboundType === BROADCAST_CHANNEL_CONNECTOR_TYPE ||
      (typeof connectorType === 'string' &&
        (connectorType === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE ||
          connectorType === BROADCAST_CHANNEL_CONNECTOR_TYPE));

    if (!matchesBroadcast) {
      return false;
    }

    return !callbackGrants.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') {
        return false;
      }

      const candidateType = (candidate as Record<string, unknown>).type;
      const candidateConnector = (candidate as Record<string, unknown>)[
        'connectorType'
      ];

      return (
        candidateType === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE ||
        candidateConnector === BROADCAST_CHANNEL_CONNECTOR_TYPE ||
        candidateConnector === BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE ||
        candidateType === BROADCAST_CHANNEL_CONNECTOR_TYPE
      );
    });
  }

  private createBroadcastCallbackGrant(
    grant: Record<string, any>
  ): Record<string, unknown> | null {
    try {
      const grantLike: BroadcastChannelConnectionGrantLike = {
        ...(grant as Record<string, unknown>),
        type: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
      };

      const normalized = normalizeBroadcastChannelConnectionGrant(grantLike);

      return withLegacySnakeCaseKeys({
        type: BROADCAST_CHANNEL_CONNECTION_GRANT_TYPE,
        purpose: normalized.purpose,
        connectorType: BROADCAST_CHANNEL_CONNECTOR_TYPE,
        channelName: normalized.channelName,
        ...(normalized.inboxCapacity !== undefined
          ? { inboxCapacity: normalized.inboxCapacity }
          : {}),
      });
    } catch (error) {
      logger.debug('broadcast_callback_grant_generation_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private getKeys(): Array<Record<string, unknown>> | null {
    const securityManager = this.node.securityManager;
    if (!securityManager || !securityManager.supportsOverlaySecurity) {
      return null;
    }

    const shareable = securityManager.getShareableKeys();
    if (Array.isArray(shareable)) {
      return shareable.length ? shareable : null;
    }
    if (shareable && typeof shareable === 'object') {
      return [shareable];
    }

    const provider = this.node.cryptoProvider;
    if (!provider) {
      return null;
    }

    const keys: Array<Record<string, unknown>> = [];
    const nodeJwk = provider.nodeJwk?.();
    if (nodeJwk) {
      keys.push(nodeJwk);
    }
    const jwks = provider.getJwks?.();
    if (jwks?.keys) {
      for (const jwk of jwks.keys) {
        if (
          nodeJwk &&
          jwk?.kid === (nodeJwk as any).kid &&
          jwk?.use !== 'enc'
        ) {
          continue;
        }
        keys.push(jwk);
      }
    }

    return keys.length ? keys : null;
  }

  private async waitForFailureOrStop(
    tasks: SpawnedTask[],
    stopEvt: AsyncEvent
  ): Promise<void> {
    const stopPromise = stopEvt.wait().then(() => ({ type: 'stop' as const }));
    const wrappedTasks = tasks.map((task) =>
      task.promise
        .then(() => ({ type: 'task' as const, error: null as Error | null }))
        .catch((error) => ({ type: 'task' as const, error: error as Error }))
    );

    const result = await Promise.race([stopPromise, ...wrappedTasks]);

    if (result.type === 'stop') {
      tasks.forEach((task) => task.cancel());
      return;
    }

    if (result.error && !(result.error instanceof TaskCancelledError)) {
      throw result.error;
    }
  }

  private async heartbeatLoop(
    connector: FameConnector,
    stopEvt: AsyncEvent,
    signal?: AbortSignal
  ): Promise<void> {
    logger.debug('starting_heartbeat_loop');
    const intervalMs = UpstreamSessionManager.HEARTBEAT_INTERVAL * 1000;
    const graceMs = intervalMs * UpstreamSessionManager.HEARTBEAT_GRACE;
    this.lastHeartbeatAckTime = Date.now();

    while (!stopEvt.isSet() && !signal?.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timer = undefined;
              resolve();
            }, intervalMs);
          }),
          this.waitEvent(stopEvt, signal),
        ]);
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          throw error;
        }
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      if (stopEvt.isSet() || signal?.aborted) {
        break;
      }

      const currentState = connector.state;
      const previousState = this.lastConnectorState;
      this.lastConnectorState = currentState;

      // Skip heartbeat if connector is paused (e.g., tab is hidden)
      // Keep ack time current so we don't timeout immediately after resuming
      if (currentState === ConnectorState.PAUSED) {
        logger.debug('skipping_heartbeat_connector_paused', {
          connector_state: currentState,
        });
        this.lastHeartbeatAckTime = Date.now();
        continue;
      }

      // Reset ack time if just resumed from pause (prevents immediate timeout)
      if (
        previousState === ConnectorState.PAUSED &&
        currentState === ConnectorState.STARTED
      ) {
        logger.debug('connector_just_resumed_resetting_ack_time', {
          previous_state: previousState,
          current_state: currentState,
        });
        this.lastHeartbeatAckTime = Date.now();
      }

      const envelope = await this.makeHeartbeatEnvelope();
      logger.debug('sending_heartbeat', {
        hb_corr_id: envelope.corrId,
        hb_env_id: envelope.id,
      });

      const context: FameDeliveryContext = {
        originType: DeliveryOriginType.LOCAL,
        expectedResponseType: FameResponseType.NONE,
      };

      try {
        await this.node.dispatchEnvelopeEvent(
          'onForwardUpstream',
          this.node,
          envelope,
          context
        );
        await connector.send(envelope);
        await this.node.dispatchEnvelopeEvent(
          'onForwardUpstreamComplete',
          this.node,
          envelope,
          undefined,
          undefined,
          context
        );
      } catch (error) {
        await this.node
          .dispatchEnvelopeEvent(
            'onForwardUpstreamComplete',
            this.node,
            envelope,
            error,
            undefined,
            context
          )
          .catch(() => undefined);
        throw error;
      }

      await this.node.dispatchEvent('onHeartbeatSent', this.node, envelope);

      // Don't check heartbeat timeout when paused
      if (
        this.lastHeartbeatAckTime !== null &&
        Date.now() - this.lastHeartbeatAckTime > graceMs
      ) {
        throw new FameConnectError('missed heartbeat acknowledgement');
      }
    }

    logger.debug('completed_heartbeat_loop');
  }

  private async messagePumpLoop(
    connector: FameConnector,
    stopEvt: AsyncEvent,
    signal?: AbortSignal
  ): Promise<void> {
    while (!stopEvt.isSet() && !signal?.aborted) {
      let envelope: FameEnvelope | null = null;
      try {
        envelope = await this.takeMessage(stopEvt, signal);
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          return;
        }
        throw error;
      }

      if (!envelope) {
        continue;
      }

      logger.debug('upstream_pump_sending_envelope', {
        envelopeId: envelope.id,
        type: envelope.frame?.type,
      });

      try {
        await connector.send(envelope);
        logger.debug('upstream_pump_sent_envelope', {
          envelopeId: envelope.id,
        });
      } catch (error) {
        if (error instanceof FameMessageTooLarge) {
          logger.error('failed_to_send_message', { error: error.message });
          await this.handleMessageTooLarge(envelope, error.message);
        } else if (error instanceof FameTransportClose) {
          this.requeueFront(envelope);
          throw error;
        } else {
          throw error;
        }
      }
    }
  }

  private requeueFront(envelope: FameEnvelope): void {
    this.messageQueue.unshift(envelope);
    this.queueEvent.set();
  }

  private async takeMessage(
    stopEvt: AsyncEvent,
    signal?: AbortSignal
  ): Promise<FameEnvelope | null> {
    while (true) {
      if (this.messageQueue.length > 0) {
        const envelope = this.messageQueue.shift()!;
        if (this.messageQueue.length === 0) {
          this.queueEvent.clear();
        }
        return envelope;
      }

      if (stopEvt.isSet() || signal?.aborted) {
        return null;
      }

      await Promise.race([
        this.waitEvent(this.queueEvent, signal),
        this.waitEvent(stopEvt, signal),
      ]);

      if (stopEvt.isSet() || signal?.aborted) {
        return null;
      }
    }
  }

  private async handleMessageTooLarge(
    envelope: FameEnvelope,
    reason: string
  ): Promise<void> {
    const corrId = envelope.corrId;
    const replyTo = envelope.replyTo as FameAddress | undefined;
    if (!corrId || !replyTo) {
      return;
    }

    try {
      const fabric = FameFabric.current();
      const nack: DeliveryAckFrame = {
        type: 'DeliveryAck',
        ok: false,
        refId: envelope.id,
        code: 'MESSAGE_TOO_LARGE',
        reason,
      };
      const target: FameAddress = replyTo;
      const ackEnvelope = this.node.envelopeFactory.createEnvelope({
        to: target,
        frame: nack,
        corrId,
      });
      await (fabric as any).send(ackEnvelope);
    } catch (error) {
      logger.warning('failed_to_send_nack', {
        error: (error as Error).message,
      });
    }
  }

  private async expiryGuard(
    connector: FameConnector,
    welcome: FameEnvelopeWith<NodeWelcomeFrame>,
    info: AttachInfo,
    stopEvt: AsyncEvent,
    signal?: AbortSignal
  ): Promise<void> {
    const timestamps: Date[] = [];
    if (welcome.frame.expiresAt) {
      timestamps.push(new Date(welcome.frame.expiresAt));
    }
    if (info.attachExpiresAt) {
      timestamps.push(info.attachExpiresAt);
    }

    if (!timestamps.length) {
      logger.debug('no_ttl_expiry_configured');
      await this.waitEvent(stopEvt, signal);
      return;
    }

    const earliest = timestamps.reduce((min, current) =>
      current < min ? current : min
    );
    const now = new Date();
    let delaySeconds =
      (earliest.getTime() - now.getTime()) / 1000 -
      UpstreamSessionManager.JWT_REFRESH_SAFETY;
    delaySeconds = Math.max(
      delaySeconds,
      UpstreamSessionManager.JWT_REFRESH_SAFETY
    );

    logger.debug('ttl_expiry_guard_started', {
      welcome_expires_at: welcome.frame.expiresAt ?? null,
      attach_expires_at: info.attachExpiresAt?.toISOString?.() ?? null,
      earliest_expiry: earliest.toISOString(),
      delay_seconds: delaySeconds,
      refresh_safety_seconds: UpstreamSessionManager.JWT_REFRESH_SAFETY,
    });

    if (delaySeconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timer = undefined;
              resolve();
            }, delaySeconds * 1000);
            timer?.unref?.();
          }),
          this.waitEvent(stopEvt, signal),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }

    if (!stopEvt.isSet()) {
      logger.debug('ttl_expiry_triggered_reconnect', {
        expires_at: earliest.toISOString(),
        current_time: new Date().toISOString(),
        seconds_before_expiry: UpstreamSessionManager.JWT_REFRESH_SAFETY,
      });
      await connector.stop();
    }
  }

  private async makeHeartbeatEnvelope(): Promise<
    FameEnvelopeWith<NodeHeartbeatFrame>
  > {
    const envelope = this.node.envelopeFactory.createEnvelope({
      frame: { type: 'NodeHeartbeat' },
      corrId: generateId(),
    });
    return envelope as FameEnvelopeWith<NodeHeartbeatFrame>;
  }

  private makeHeartbeatEnabledHandler(
    downstream: FameEnvelopeHandler
  ): FameEnvelopeHandler {
    return async (env: FameEnvelope, context?: FameDeliveryContext) => {
      const authorizationContext = this.connector?.authorizationContext;

      if (!context) {
        context = {
          originType: this.inboundOriginType,
          fromConnector: this.connector ?? undefined,
          fromSystemId: this.targetSystemId ?? undefined,
          security: {
            authorization: authorizationContext,
          } as SecurityContext,
          expectedResponseType: FameResponseType.NONE,
        };
      } else {
        context.originType = this.inboundOriginType;
        context.fromConnector = this.connector ?? undefined;
        context.fromSystemId = this.targetSystemId ?? undefined;
        if (!context.security) {
          context.security = {} as SecurityContext;
        }
        if (!context.security.authorization) {
          context.security.authorization = authorizationContext;
        }
        if (context.expectedResponseType === undefined) {
          context.expectedResponseType = FameResponseType.NONE;
        }
      }

      await this.node.dispatchEnvelopeEvent(
        'onEnvelopeReceived',
        this.node,
        env,
        context
      );

      if ((env.frame as NodeHeartbeatAckFrame).type === 'NodeHeartbeatAck') {
        logger.debug('received_heartbeat_ack', {
          hb_ack_env_id: env.id,
          hb_ack_corr_id: env.corrId,
          hb_routing_epoch: (env.frame as NodeHeartbeatAckFrame).routingEpoch,
        });

        await this.node.dispatchEvent('onHeartbeatReceived', this.node, env);
        this.lastHeartbeatAckTime = Date.now();
        const epoch = (env.frame as NodeHeartbeatAckFrame).routingEpoch;
        if (epoch && epoch !== this.lastSeenEpoch) {
          this.lastSeenEpoch = epoch;
          if (this.onEpochChange) {
            await this.onEpochChange(epoch);
          } else {
            logger.warning('parent_epoch_changed', { epoch });
          }
        }
        return;
      }

      if ((env.frame as NodeAttachAckFrame).type === 'NodeAttachAck') {
        return;
      }

      return await downstream(env, context);
    };
  }
}
