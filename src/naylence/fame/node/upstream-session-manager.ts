import { ConnectorFactory } from '../connector/connector-factory.js';
import { TaskSpawner } from '../util/task-spawner.js';
import { AsyncEvent } from '../util/async-event.js';
import { getLogger } from '../util/logging.js';
import {
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
import type {
  NodeAttachClient,
  AttachInfo,
} from './admission/node-attach-client.js';
import type { NodeLike } from './node-like.js';
import type { SessionManager } from './session-manager.js';
import { TaskCancelledError, SpawnedTask } from '../util/task-types.js';
import type { FameAddress } from '@naylence/core';
import { FameResponseType } from '@naylence/core';

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
  private readonly queueEvent = new AsyncEvent();
  private currentStopSubtasks: AsyncEvent | null = null;

  private readonly messageQueue: FameEnvelope[] = [];

  private fsmTask: SpawnedTask<void> | null = null;
  private connector: FameConnector | null = null;
  private targetSystemId: string | null = null;
  private lastHeartbeatAckTime: number | null = null;
  private lastSeenEpoch: string | null = null;
  private hadSuccessfulAttach = false;
  private connectEpoch = 0;

  constructor(options: UpstreamSessionManagerOptions) {
    super();
    this.node = options.node;
    this.attachClient = options.attachClient;
    this.requestedLogicals = options.requestedLogicals;
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

    logger.debug('created_upstream_session_manager', {
      target_system_id: this.targetSystemId,
    });
  }

  get systemId(): string | null {
    return this.targetSystemId;
  }

  async start(options: { waitUntilReady?: boolean } = {}): Promise<void> {
    const { waitUntilReady = true } = options;
    if (this.fsmTask) {
      return;
    }

    this.stopEvent.clear();
    this.readyEvent.clear();

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

    while (!this.stopEvent.isSet()) {
      try {
        await this.connectCycle();
        delay = UpstreamSessionManager.BACKOFF_INITIAL;
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          throw error;
        }

        if (
          error instanceof FameTransportClose ||
          error instanceof FameConnectError
        ) {
          logger.warning('upstream_link_closed', {
            error: error.message,
            will_retry: true,
          });
          if (!this.hadSuccessfulAttach && error instanceof FameConnectError) {
            throw error;
          }
        } else {
          logger.warning('upstream_link_closed', {
            error: (error as Error).message,
            will_retry: true,
            exc_info: true,
          });
          if (!this.hadSuccessfulAttach) {
            throw error;
          }
        }

        delay = await this.applyBackoff(delay);
      }
    }
  }

  private async applyBackoff(delay: number): Promise<number> {
    const jitter = Math.random() * delay;
    await this.sleepWithStop(delay + jitter);
    return Math.min(delay * 2, UpstreamSessionManager.BACKOFF_CAP);
  }

  private async sleepWithStop(delaySeconds: number): Promise<void> {
    if (delaySeconds <= 0) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const sleepPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timeout = undefined;
        resolve();
      }, delaySeconds * 1000);
    });

    await Promise.race([sleepPromise, this.stopEvent.wait()]);

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
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

  private async connectCycle(): Promise<void> {
    if (!this.admissionClient) {
      throw new FameConnectError(
        'Admission client is required to attach upstream'
      );
    }

    this.connectEpoch += 1;

    const welcome = await this.admissionClient.hello(
      this.node.id,
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
    });

    await connector.start(this.wrappedHandler);
    this.connector = connector;
    const callbackGrants = this.node.gatherSupportedCallbackGrants();
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
        await this.connector.stop().catch(() => undefined);
        this.connector = null;
      }
    }

    if (failure) {
      throw failure;
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

      try {
        await connector.send(envelope);
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
