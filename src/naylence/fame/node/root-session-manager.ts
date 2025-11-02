import { generateId, type NodeWelcomeFrame } from '@naylence/core';
import { TaskSpawner } from '../util/task-spawner.js';
import { AsyncEvent } from '../util/async-event.js';
import { getLogger } from '../util/logging.js';
import type { SessionManager } from './session-manager.js';
import type { NodeLike } from './node-like.js';
import type { AdmissionClient } from './admission/admission-client.js';
import { FameConnectError } from '../errors/errors.js';
import type { SpawnedTask } from '../util/task-types.js';
import { TaskCancelledError } from '../util/task-types.js';

const logger = getLogger('naylence.fame.node.root_session_manager');

type MaybePromise<T> = T | Promise<T>;

type WelcomeCallback = (frame: NodeWelcomeFrame) => MaybePromise<void>;

type EpochCallback = (epoch: string) => MaybePromise<void>;

type AdmissionFailureCallback = (error: Error) => MaybePromise<void>;

export interface RootSessionManagerOptions {
  node: NodeLike;
  admissionClient: AdmissionClient;
  requestedLogicals: string[];
  onWelcome: WelcomeCallback;
  onEpochChange?: EpochCallback;
  onAdmissionFailed?: AdmissionFailureCallback;
  enableContinuousRefresh?: boolean;
}

type RootSessionManagerOptionsInput = RootSessionManagerOptions & {
  admission_client?: AdmissionClient;
  requested_logicals?: unknown;
  on_welcome?: WelcomeCallback;
  on_epoch_change?: EpochCallback;
  on_admission_failed?: AdmissionFailureCallback;
  enable_continuous_refresh?: unknown;
};

function resolveOption<T>(
  options: RootSessionManagerOptionsInput,
  primary: keyof RootSessionManagerOptions,
  ...aliases: string[]
): T | undefined {
  const record = options as unknown as Record<string, unknown>;
  const primaryKey = primary as string;
  if (record[primaryKey] !== undefined) {
    return record[primaryKey] as T;
  }

  for (const alias of aliases) {
    if (record[alias] !== undefined) {
      return record[alias] as T;
    }
  }

  return undefined;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function resolveStringArrayOption(
  options: RootSessionManagerOptionsInput,
  primary: keyof RootSessionManagerOptions,
  ...aliases: string[]
): string[] | undefined {
  const value = resolveOption<unknown>(options, primary, ...aliases);
  if (value === undefined) {
    return undefined;
  }
  return coerceStringArray(value);
}

function resolveBooleanOption(
  options: RootSessionManagerOptionsInput,
  primary: keyof RootSessionManagerOptions,
  ...aliases: string[]
): boolean | undefined {
  const value = resolveOption<unknown>(options, primary, ...aliases);
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return undefined;
}

export class RootSessionManager extends TaskSpawner implements SessionManager {
  public static readonly BACKOFF_INITIAL = 1.0;
  public static readonly BACKOFF_CAP = 30.0;
  public static readonly RETRY_MAX_ATTEMPTS = 5;
  public static readonly JWT_REFRESH_SAFETY = 60.0;

  private readonly node: NodeLike;
  private readonly admissionClient: AdmissionClient;
  private readonly requestedLogicals: string[];
  private readonly onWelcome: WelcomeCallback;
  private readonly onEpochChange: EpochCallback | undefined;
  private readonly onAdmissionFailed: AdmissionFailureCallback | undefined;
  private readonly enableContinuousRefresh: boolean;

  private readonly readyEvent = new AsyncEvent();
  private readonly stopEvent = new AsyncEvent();

  private admissionTask: SpawnedTask<void> | null = null;
  private expiryGuardTask: SpawnedTask<void> | null = null;
  private hadSuccessfulAdmission = false;
  private admissionEpoch = 0;
  private currentWelcome: NodeWelcomeFrame | null = null;

  constructor(options: RootSessionManagerOptionsInput) {
    super();
    const node = resolveOption<NodeLike | undefined>(options, 'node');
    const admissionClient = resolveOption<AdmissionClient | undefined>(
      options,
      'admissionClient',
      'admission_client'
    );
    const requestedLogicals =
      resolveStringArrayOption(
        options,
        'requestedLogicals',
        'requested_logicals'
      ) ?? [];
    const onWelcome = resolveOption<WelcomeCallback | undefined>(
      options,
      'onWelcome',
      'on_welcome'
    );
    const onEpochChange = resolveOption<EpochCallback | undefined>(
      options,
      'onEpochChange',
      'on_epoch_change'
    );
    const onAdmissionFailed = resolveOption<
      AdmissionFailureCallback | undefined
    >(options, 'onAdmissionFailed', 'on_admission_failed');
    const enableContinuousRefresh = resolveBooleanOption(
      options,
      'enableContinuousRefresh',
      'enable_continuous_refresh'
    );

    if (!node) {
      throw new Error('RootSessionManager requires a node option');
    }
    if (!admissionClient) {
      throw new Error('RootSessionManager requires an admissionClient option');
    }
    if (!onWelcome) {
      throw new Error('RootSessionManager requires an onWelcome callback');
    }

    this.node = node;
    this.admissionClient = admissionClient;
    this.requestedLogicals = [...requestedLogicals];
    this.onWelcome = onWelcome;
    this.onEpochChange =
      typeof onEpochChange === 'function' ? onEpochChange : undefined;
    this.onAdmissionFailed =
      typeof onAdmissionFailed === 'function' ? onAdmissionFailed : undefined;
    this.enableContinuousRefresh = enableContinuousRefresh ?? true;

    logger.debug('created_root_session_manager');
  }

  public get isReady(): boolean {
    return this.readyEvent.isSet();
  }

  public get currentWelcomeFrame(): NodeWelcomeFrame | null {
    return this.currentWelcome;
  }

  public get admissionExpiresAt(): Date | null {
    const expiresAt = this.currentWelcome?.expiresAt;
    if (!expiresAt) {
      return null;
    }
    try {
      return new Date(expiresAt);
    } catch {
      return null;
    }
  }

  public async start(
    options: { waitUntilReady?: boolean } = {}
  ): Promise<void> {
    const { waitUntilReady = true } = options;

    if (this.admissionTask) {
      return;
    }

    logger.debug('root_session_manager_starting');

    this.stopEvent.clear();
    this.readyEvent.clear();

    const taskName = `root-admission-${this.admissionEpoch}`;
    this.admissionTask = this.spawn((signal) => this.admissionLoop(signal), {
      name: taskName,
    });

    if (!waitUntilReady) {
      return;
    }

    try {
      await Promise.race([this.readyEvent.wait(), this.admissionTask.promise]);
    } catch (error) {
      throw error;
    }

    if (!this.readyEvent.isSet()) {
      await this.admissionTask.promise;
      throw new FameConnectError('Root session manager failed to become ready');
    }

    logger.debug('root_session_manager_started');
  }

  public async stop(): Promise<void> {
    logger.debug('root_session_manager_stopping');
    this.stopEvent.set();

    if (this.admissionTask) {
      this.admissionTask.cancel();
      await this.consumeTask(this.admissionTask);
      this.admissionTask = null;
    }

    if (this.expiryGuardTask) {
      this.expiryGuardTask.cancel();
      await this.consumeTask(this.expiryGuardTask);
      this.expiryGuardTask = null;
    }

    logger.debug('root_session_manager_stopped');
  }

  public async awaitReady(timeoutMs?: number): Promise<void> {
    if (this.isReady) {
      return;
    }

    const admissionTask = this.admissionTask;
    if (!admissionTask) {
      return;
    }

    const waitPromises: Array<Promise<void>> = [
      this.readyEvent.wait(),
      admissionTask.promise,
    ];
    if (timeoutMs !== undefined) {
      waitPromises.push(this.waitWithTimeout(timeoutMs));
    }

    await Promise.race(waitPromises);

    if (!this.isReady) {
      await admissionTask.promise;
      throw new FameConnectError(
        'Root session manager terminated before ready'
      );
    }
  }

  public async performAdmission(): Promise<NodeWelcomeFrame> {
    this.admissionEpoch += 1;
    this.initializeRootIdentityIfNeeded();

    const welcome = await this.admissionClient.hello(
      this.node.id,
      generateId(),
      this.requestedLogicals
    );

    this.currentWelcome = welcome.frame;

    const cryptoProvider = this.node.cryptoProvider; //getCryptoProvider();
    if (welcome.frame.assignedPath && cryptoProvider?.prepareForAttach) {
      cryptoProvider.prepareForAttach(
        welcome.frame.systemId,
        welcome.frame.assignedPath,
        welcome.frame.acceptedLogicals ?? []
      );
    }

    // Close the admission client immediately after handshake completes
    // This releases HTTP keep-alive connections (Node.js fetch/undici requires explicit cleanup)
    await this.admissionClient.close();

    return welcome.frame;
  }

  public async handleEpochChange(epoch: string): Promise<void> {
    if (this.onEpochChange) {
      await this.onEpochChange(epoch);
    } else {
      logger.debug('epoch_change_ignored_no_handler', { epoch });
    }
  }

  public static createForRootSentinel(
    node: NodeLike,
    admissionClient: AdmissionClient,
    requestedLogicals: string[] = [],
    enableContinuousRefresh = true,
    onEpochChange?: EpochCallback
  ): RootSessionManager {
    const handleWelcome: WelcomeCallback = async (frame) => {
      logger.info('root_admission_successful', {
        system_id: frame.systemId,
        assigned_path: frame.assignedPath ?? null,
        accepted_logicals: frame.acceptedLogicals ?? [],
        grants_count: frame.connectionGrants?.length ?? 0,
      });

      for (const grant of frame.connectionGrants ?? []) {
        const purpose =
          typeof grant === 'object' && grant
            ? (grant as Record<string, any>).purpose
            : undefined;
        if (purpose) {
          logger.debug('received_admission_grant', { purpose });
        }
      }
    };

    const handleFailure: AdmissionFailureCallback = async (error) => {
      logger.error('root_admission_failed_permanently', {
        error: error.message,
      });
    };

    const options: RootSessionManagerOptions = {
      node,
      admissionClient,
      requestedLogicals,
      enableContinuousRefresh,
      onWelcome: handleWelcome,
      onAdmissionFailed: handleFailure,
      ...(onEpochChange ? { onEpochChange } : {}),
    };

    return new RootSessionManager(options);
  }

  private async admissionLoop(signal?: AbortSignal): Promise<void> {
    let delay = RootSessionManager.BACKOFF_INITIAL;
    let attempts = 0;

    while (
      !this.stopEvent.isSet() &&
      !signal?.aborted &&
      attempts < RootSessionManager.RETRY_MAX_ATTEMPTS
    ) {
      try {
        attempts += 1;
        const welcomeFrame = await this.performAdmission();

        await this.onWelcome(welcomeFrame);

        if (!this.readyEvent.isSet()) {
          this.readyEvent.set();
        }

        if (this.hadSuccessfulAdmission) {
          logger.debug('root_admission_refreshed');
        } else {
          logger.debug('root_admission_completed');
        }

        this.hadSuccessfulAdmission = true;
        delay = RootSessionManager.BACKOFF_INITIAL;
        attempts = 0;

        if (this.enableContinuousRefresh && welcomeFrame.expiresAt) {
          await this.startExpiryGuard(welcomeFrame);
          const expiryTriggered = await this.waitForExpiryOrStop();
          if (expiryTriggered && !this.stopEvent.isSet()) {
            logger.debug('performing_scheduled_re_admission');
            continue;
          }
        }

        return;
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          throw error;
        }

        const errorObject =
          error instanceof Error ? error : new Error(String(error));
        const willRetry = attempts < RootSessionManager.RETRY_MAX_ATTEMPTS;

        logger.warning('root_admission_failed', {
          error: errorObject.message,
          attempt: attempts,
          will_retry: willRetry,
          exc_info: !(errorObject instanceof FameConnectError),
        });

        if (!this.hadSuccessfulAdmission && !willRetry) {
          if (this.onAdmissionFailed) {
            await this.onAdmissionFailed(errorObject);
          }
          throw errorObject;
        }

        if (willRetry) {
          delay = await this.applyBackoff(delay, signal);
        }
      }
    }

    if (attempts >= RootSessionManager.RETRY_MAX_ATTEMPTS) {
      logger.error('root_admission_max_attempts_exceeded', {
        max_attempts: RootSessionManager.RETRY_MAX_ATTEMPTS,
      });
    }
  }

  private async applyBackoff(
    delay: number,
    signal?: AbortSignal
  ): Promise<number> {
    const jitter = Math.random() * delay;
    await this.sleepWithStop(delay + jitter, signal);
    return Math.min(delay * 2, RootSessionManager.BACKOFF_CAP);
  }

  private async sleepWithStop(
    delaySeconds: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (delaySeconds <= 0) {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        timeoutId = undefined;
        resolve();
      }, delaySeconds * 1000);
    });

    try {
      await Promise.race([
        timeoutPromise,
        this.stopEvent.wait(),
        this.waitForAbort(signal),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async startExpiryGuard(
    welcomeFrame: NodeWelcomeFrame
  ): Promise<void> {
    if (this.expiryGuardTask) {
      this.expiryGuardTask.cancel();
      await this.consumeTask(this.expiryGuardTask);
      this.expiryGuardTask = null;
    }

    this.expiryGuardTask = this.spawn(
      (signal) => this.expiryGuard(welcomeFrame, signal),
      {
        name: `root-expiry-guard-${this.admissionEpoch}`,
      }
    );
  }

  private async waitForExpiryOrStop(): Promise<boolean> {
    const expiryTask = this.expiryGuardTask;
    if (!expiryTask) {
      return false;
    }

    try {
      const result = await Promise.race<'expiry' | 'stop'>([
        expiryTask.promise.then(() => 'expiry'),
        this.stopEvent.wait().then(() => 'stop'),
      ]);

      if (result === 'stop') {
        expiryTask.cancel();
        await this.consumeTask(expiryTask);
        return false;
      }

      return !this.stopEvent.isSet();
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        return false;
      }
      throw error;
    } finally {
      if (
        expiryTask.isCancelled() ||
        expiryTask.isCompleted() ||
        expiryTask.isFailed()
      ) {
        this.expiryGuardTask = null;
      }
    }
  }

  private async expiryGuard(
    welcomeFrame: NodeWelcomeFrame,
    signal?: AbortSignal
  ): Promise<void> {
    if (!welcomeFrame.expiresAt) {
      logger.debug('no_admission_expiry_configured');
      await Promise.race([this.stopEvent.wait(), this.waitForAbort(signal)]);
      return;
    }

    const expiresAt = new Date(welcomeFrame.expiresAt);
    const now = new Date();
    let delaySeconds =
      (expiresAt.getTime() - now.getTime()) / 1000 -
      RootSessionManager.JWT_REFRESH_SAFETY;
    delaySeconds = Math.max(delaySeconds, 0);

    logger.debug('admission_expiry_guard_started', {
      welcome_expires_at: expiresAt.toISOString(),
      delay_seconds: delaySeconds,
      refresh_safety_seconds: RootSessionManager.JWT_REFRESH_SAFETY,
    });

    await this.sleepWithStop(delaySeconds, signal);

    if (this.stopEvent.isSet() || signal?.aborted) {
      return;
    }

    logger.debug('admission_expiry_triggered_refresh', {
      expires_at: expiresAt.toISOString(),
      current_time: new Date().toISOString(),
      seconds_before_expiry: RootSessionManager.JWT_REFRESH_SAFETY,
    });
  }

  private initializeRootIdentityIfNeeded(): void {
    const nodeAny = this.node as any;
    if (!this.node.id) {
      nodeAny._id = generateId();
      logger.debug('root_identity_generated_id_for_admission', {
        system_id: this.node.id,
      });
    }
  }

  private async consumeTask(task: SpawnedTask<void>): Promise<void> {
    try {
      await task.promise;
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        return;
      }
      const errorObject =
        error instanceof Error ? error : new Error(String(error));
      logger.debug('background_task_error', {
        task_name: task.name,
        error: errorObject.message,
      });
    }
  }

  private waitForAbort(signal?: AbortSignal): Promise<never> {
    if (!signal) {
      return new Promise<never>(() => {});
    }
    if (signal.aborted) {
      return Promise.reject(new TaskCancelledError('root-session-aborted'));
    }
    return new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new TaskCancelledError('root-session-aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private waitWithTimeout(timeoutMs: number): Promise<void> {
    return new Promise<void>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(
          new FameConnectError(
            'Timed out waiting for root session manager readiness'
          )
        );
      }, timeoutMs);
    });
  }
}
