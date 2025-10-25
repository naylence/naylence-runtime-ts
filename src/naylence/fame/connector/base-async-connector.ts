/**
 * BaseAsyncConnector - Abstract async transport adapter with optional flow control
 *
 * Enhanced connector with cleaner shutdown, better back-pressure reporting,
 * and richer metrics/logging. Maintains backwards compatibility with subclasses.
 */

/**
 * Error thrown when a task is cancelled during shutdown - not a critical error
 */
export class TaskCancellationError extends Error {
  constructor(message: string = 'Task cancelled') {
    super(message);
    this.name = 'TaskCancellationError';
  }
}

import { TaskSpawner } from '../util/task-spawner.js';
import { TaskSpawnerConfig } from '../util/task-types.js';
import { FlowController } from '../channel/flow-controller.js';
import { _NoopFlowController } from './noop-flow-controller.js';
import { getLogger } from '../util/logging.js';
import { color, AnsiColor } from '../util/formatter.js';
import { MetricsEmitter } from '../util/metrics-emitter.js';
import { withEnvelopeContextAsync } from '../util/envelope-context.js';
import {
  formatTimestampForConsole,
  isEnvelopeLoggingEnabled,
  prettyModel,
} from '../util/util.js';
import {
  ConnectorState,
  ConnectorStateUtils,
  FameConnector,
  FameEnvelope,
  FameEnvelopeHandler,
  FameChannelMessage,
  FameDeliveryContext,
  CreditUpdateFrame,
  createFameEnvelope,
  generateId,
  FlowFlags,
  FameResponseType,
  AuthorizationContext,
} from '@naylence/core';
import {
  FameMessageTooLarge,
  FameTransportClose,
  BackPressureFull,
} from '../errors/errors.js';

const logger = getLogger('naylence.fame.connector.base_async_connector');

// Environment variables
const ENV_VAR_FAME_FLOW_CONTROL = 'FAME_FLOW_CONTROL';

const FLOW_CONTROL_ENABLED = process.env[ENV_VAR_FAME_FLOW_CONTROL] !== '0';
const FAME_MAX_MESSAGE_SIZE = 1024 * 256;

// Sentinel object for stopping send loop
// Remove stop sentinel - using shutdown flag instead
type QueueItem = Uint8Array;

/**
 * Configuration options for BaseAsyncConnector
 */
export interface BaseAsyncConnectorConfig {
  /** Maximum number of items in send queue */
  maxQueueSize?: number;
  /** Initial flow control window size */
  initialWindow?: number;
  /** Timeout for draining queues during shutdown */
  drainTimeout?: number;
  /** Enable/disable flow control (overrides environment variable) */
  flowControl?: boolean;
  /** Optional metrics emitter */
  metricsEmitter?: MetricsEmitter;
  /** TaskSpawner configuration for background task management */
  taskSpawner?: TaskSpawnerConfig;
  /** Shutdown timeout configuration for testing */
  shutdownTimeouts?: {
    /** Grace period for task shutdown in seconds (default: 2.0) */
    gracePeriod?: number;
    /** Join timeout for hanging tasks in milliseconds (default: 1000) */
    joinTimeout?: number;
  };
  /** Optional authorization context for the connector */
  authorizationContext?: AuthorizationContext | undefined;
}

/**
 * Abstract base class for async transport adapters with optional flow control.
 *
 * Provides:
 * - Async send/receive loops with proper error handling
 * - Optional credit-based flow control
 * - Graceful shutdown with task cleanup
 * - Back-pressure management
 * - Metrics and logging integration
 */
export abstract class BaseAsyncConnector
  extends TaskSpawner
  implements FameConnector
{
  private readonly _metrics: MetricsEmitter | undefined;
  private _handler?: FameEnvelopeHandler;

  // FameConnector required property
  private _authorizationContext: AuthorizationContext | undefined;

  // Send queue for outbound messages
  private readonly _sendQueue: QueueItem[] = [];
  private readonly _maxQueueSize: number;
  private _sendPromiseResolve?: (() => void) | undefined;
  private _sendLoopShutdown = false; // Flag to indicate send loop should stop
  private _closed = false;
  private _closePromise?: Promise<void>;
  private _closeResolver?: () => void;

  // Connector state management
  private _state = ConnectorState.INITIALIZED;
  private _closeCode?: number;
  private _closeReason?: string;
  private _lastError?: Error;

  // Flow control
  private readonly _flowCtrl: FlowController | _NoopFlowController;
  private readonly _fcEnabled: boolean;
  private readonly _initialWindow: number;
  private readonly _connectorFlowId: string;

  // Shutdown timeouts
  private readonly _shutdownGracePeriod: number;
  private readonly _shutdownJoinTimeout: number;

  constructor(config: BaseAsyncConnectorConfig = {}) {
    super(config.taskSpawner);

    this._maxQueueSize = config.maxQueueSize ?? 1000;
    this._metrics = config.metricsEmitter;
    this._initialWindow = config.initialWindow ?? 32;
    this._connectorFlowId = generateId();
    this._authorizationContext = config.authorizationContext;

    // Initialize shutdown timeouts
    this._shutdownGracePeriod = config.shutdownTimeouts?.gracePeriod ?? 2.0;
    this._shutdownJoinTimeout = config.shutdownTimeouts?.joinTimeout ?? 1000;

    // Initialize flow control
    const useFlowControl = config.flowControl ?? FLOW_CONTROL_ENABLED;
    if (useFlowControl) {
      this._flowCtrl = new FlowController(this._initialWindow);
      this._fcEnabled = true;
    } else {
      this._flowCtrl = new _NoopFlowController();
      this._fcEnabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // State Management Properties
  // ---------------------------------------------------------------------

  /** Get the current connector state */
  get state(): ConnectorState {
    return this._state;
  }

  /** Get the current connector state (alias for compatibility) */
  get connectorState(): ConnectorState {
    return this._state;
  }

  /** Get the close code if connector was closed */
  get closeCode(): number | undefined {
    return this._closeCode;
  }

  /** Get the close reason if connector was closed */
  get closeReason(): string | undefined {
    return this._closeReason;
  }

  /** Get the last error that occurred */
  get lastError(): Error | undefined {
    return this._lastError;
  }

  /** Get the current authorization context */
  get authorizationContext(): AuthorizationContext | undefined {
    return this._authorizationContext;
  }

  /** Set the authorization context */
  set authorizationContext(context: AuthorizationContext | undefined) {
    this._authorizationContext = context;
  }

  /**
   * Update the connector state and log the transition
   */
  private _setState(newState: ConnectorState): void {
    if (this._state !== newState) {
      const oldState = this._state;
      this._state = newState;
      logger.debug('connector_state_transition', {
        connector_id: this._connectorFlowId,
        old_state: oldState,
        new_state: newState,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle Methods
  // ---------------------------------------------------------------------

  /**
   * Start the connector with an inbound message handler
   */
  async start(inboundHandler: FameEnvelopeHandler): Promise<void> {
    if (!ConnectorStateUtils.canStart(this._state)) {
      if (this._state === ConnectorState.STARTED) {
        throw new Error('Connector already started');
      }
      throw new Error(`Cannot start connector in state: ${this._state}`);
    }

    if (this._handler !== undefined) {
      throw new Error('Connector already started');
    }

    this._handler = inboundHandler;

    // Start background tasks
    this.spawn((signal) => this._sendLoop(signal), { name: 'send-loop' });
    this.spawn((signal) => this._receiveLoop(signal), { name: 'receive-loop' });

    this._setState(ConnectorState.STARTED);
  }

  /**
   * Replace the current message handler
   */
  async replaceHandler(handler: FameEnvelopeHandler): Promise<void> {
    this._handler = handler;
  }

  /**
   * Stop the connector gracefully
   */
  async stop(): Promise<void> {
    if (!ConnectorStateUtils.canStop(this._state)) {
      logger.debug('connector_stop_already_stopped', {
        current_state: this._state,
        connector_id: this._connectorFlowId,
      });
      return;
    }

    this._setState(ConnectorState.STOPPED);
    await this._shutdown(1000, 'normal closure');

    if (this._lastError) {
      throw this._lastError;
    }
  }

  /**
   * Close the connector with optional code and reason
   */
  async close(code = 1000, reason = 'normal closure'): Promise<void> {
    if (!ConnectorStateUtils.canClose(this._state)) {
      logger.warning('connector_close_invalid_state', {
        current_state: this._state,
        connector_id: this._connectorFlowId,
      });
      return;
    }

    this._setState(ConnectorState.CLOSED);
    await this._shutdown(code, reason);

    if (this._lastError) {
      throw this._lastError;
    }
  }

  /**
   * Wait until the connector is closed
   */
  async waitUntilClosed(): Promise<void> {
    if (!this._closePromise) {
      this._closePromise = new Promise<void>((resolve) => {
        this._closeResolver = resolve;
      });
    }
    await this._closePromise;
  }

  /**
   * Push data to the receive queue for processing.
   * Subclasses should implement this to handle incoming data.
   */
  async pushToReceive(
    _rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): Promise<void> {
    throw new Error('Subclasses must implement pushToReceive()');
  }

  // Backwards compatibility alias
  async _receiveLoop(signal?: AbortSignal): Promise<void> {
    return this._recvLoop(signal);
  }

  // ---------------------------------------------------------------------
  // Public Send Method
  // ---------------------------------------------------------------------

  /**
   * Send a FAME envelope through the transport
   */
  async send(envelope: FameEnvelope): Promise<void> {
    if (this._closed) {
      throw new FameTransportClose('Connection closed', 1006);
    }

    // Apply flow control if enabled and not a credit update
    if (
      this._fcEnabled &&
      !(
        envelope.frame &&
        'flow_id' in envelope.frame &&
        'credits' in envelope.frame
      )
    ) {
      const flowId = envelope.flowId || this._connectorFlowId;
      envelope.flowId = flowId;

      const t0 = this._metrics ? performance.now() : 0;
      await this._flowCtrl.acquire(flowId);

      if (this._metrics) {
        this._metrics.histogram(
          'connector.acquire_latency',
          performance.now() - t0,
          {
            flow_id: flowId,
          }
        );
      }

      // Set sequence ID and flow flags if using real flow controller
      if (this._flowCtrl instanceof FlowController) {
        const [wnd, flags] = this._flowCtrl.nextWindow(flowId);
        envelope.seqId = wnd;
        envelope.flowFlags = (envelope.flowFlags || FlowFlags.NONE) | flags;
      }
    }

    // Serialize envelope
    const raw = new TextEncoder().encode(JSON.stringify(envelope));
    const rawSize = raw.length;

    if (rawSize > FAME_MAX_MESSAGE_SIZE) {
      throw new FameMessageTooLarge(
        `Message size ${rawSize} exceeds maximum ${FAME_MAX_MESSAGE_SIZE}`
      );
    }

    // Check queue capacity before adding for backpressure
    if (this._sendQueue.length >= this._maxQueueSize) {
      const depth = this._sendQueue.length;
      throw new BackPressureFull(
        `send-queue full (${depth}/${this._maxQueueSize})`
      );
    }

    // Add to queue and notify send loop
    this._sendQueue.push(raw);

    // Log for debugging
    logger.debug('send_envelope_queued', {
      queue_length: this._sendQueue.length,
      max_queue_size: this._maxQueueSize,
    });

    this._wakeUpSendLoop();

    if (this._metrics) {
      this._metrics.gauge(
        'connector.send_queue_depth',
        this._sendQueue.length,
        {
          connector: this.constructor.name,
        }
      );
    }
  }

  /**
   * Wake up the send loop to process queued items
   */
  private _wakeUpSendLoop(): void {
    if (this._sendPromiseResolve) {
      this._sendPromiseResolve();
      this._sendPromiseResolve = undefined;
    }
  }

  /**
   * Internal send loop that processes the send queue
   */
  private async _sendLoop(signal?: AbortSignal): Promise<void> {
    try {
      while (!this._closed && !this._sendLoopShutdown && !signal?.aborted) {
        // Wait for data in queue with cancellation support
        while (
          this._sendQueue.length === 0 &&
          !this._closed &&
          !this._sendLoopShutdown &&
          !signal?.aborted
        ) {
          await new Promise<void>((resolve, reject) => {
            // Remove redundant signal check - the event listener handles it
            this._sendPromiseResolve = resolve;
            const timeoutId = setTimeout(resolve, 100); // Fallback timeout

            // Listen for cancellation
            const abortHandler = () => {
              clearTimeout(timeoutId);
              reject(new TaskCancellationError());
            };
            signal?.addEventListener('abort', abortHandler, { once: true });
          });
        }

        if (this._closed || signal?.aborted) break;

        // Look at the first item without removing it yet
        const item = this._sendQueue[0];
        if (!item) continue;

        logger.debug('send_loop_processing_item', {
          queue_length_before_send: this._sendQueue.length,
        });

        // Send through transport (this may block)
        await this._transportSendBytes(item as Uint8Array);

        // Only remove from queue after successful send
        this._sendQueue.shift();

        logger.debug('send_loop_item_sent', {
          queue_length_after_send: this._sendQueue.length,
        });
      }
    } catch (error) {
      if (error instanceof FameTransportClose) {
        const code = error.code ?? 1006;
        const reason = error.message;
        await this._shutdown(code, reason, undefined, error);
      } else if (error instanceof TaskCancellationError) {
        // Task cancellation is expected during shutdown - log as debug, not critical
        logger.debug('send loop cancelled', {
          connector: this.constructor.name,
          reason: error.message,
        });
        // Don't re-throw - this is normal during shutdown
      } else {
        logger.critical('unexpected exception in send loop', {
          connector: this.constructor.name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  /**
   * Internal receive loop that processes incoming messages
   */
  private async _recvLoop(signal?: AbortSignal): Promise<void> {
    if (!this._handler) {
      throw new Error('Handler not set');
    }

    try {
      while (!this._closed && !signal?.aborted) {
        // Remove redundant signal check - loop condition handles it
        const message = await this._transportReceive();
        let messageContext: FameDeliveryContext | undefined;
        let env: FameEnvelope;

        // Parse the incoming message
        if (message && typeof message === 'object' && 'envelope' in message) {
          // FameChannelMessage
          const channelMsg = message as FameChannelMessage;
          env = channelMsg.envelope;
          messageContext = channelMsg.context;
        } else if (
          message &&
          typeof message === 'object' &&
          'frame' in message
        ) {
          // FameEnvelope
          env = message as FameEnvelope;
        } else if (message instanceof Uint8Array) {
          // Raw bytes - parse as JSON
          try {
            const jsonStr = new TextDecoder().decode(message);
            env = JSON.parse(jsonStr) as FameEnvelope;
          } catch (error) {
            logger.error('Invalid envelope', {
              message: message.toString(),
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
        } else if (message instanceof FameTransportClose) {
          // Transport close - initiate shutdown
          const code = message.code ?? 1006;
          const reason = message.message;
          await this._shutdownWithError(message, code, reason);
          return;
        } else {
          throw new Error(
            `Expected FameEnvelope, Uint8Array, or FameTransportClose, got ${typeof message}`
          );
        }

        // Process the envelope
        const envelopeContext = {
          ...(env.traceId && { trace_id: env.traceId }),
          ...(env.flowId && { flow_id: env.flowId }),
        };
        await withEnvelopeContextAsync(envelopeContext, async () => {
          const prettyEnvelope = prettyModel(env);
          logger.trace('connector_received_envelope', {
            envelope: env,
            pretty: prettyEnvelope,
          });

          if (isEnvelopeLoggingEnabled()) {
            console.log(
              `\n${formatTimestampForConsole()} - ${color('Received envelope 📨', AnsiColor.BLUE)}\n${prettyEnvelope}`
            );
          }

          // Handle credit updates
          if (env.frame && env.frame.type === 'CreditUpdate') {
            const creditFrame = env.frame as CreditUpdateFrame;
            this._flowCtrl.addCredits(creditFrame.flowId, creditFrame.credits);
            return;
          }

          // Deliver to handler
          const context = messageContext || {
            fromConnector: this,
            expectedResponseType: FameResponseType.NONE,
          };

          await this._handler!(env, context);

          // Consume credit and emit refill if needed
          const flowId = env.flowId || this._connectorFlowId;
          this._flowCtrl.consume(flowId);
          await this._maybeEmitCredit(flowId, env.traceId);
        });
      }
    } catch (error) {
      if (error instanceof FameTransportClose) {
        const code = error.code ?? 1006;
        const reason = error.message;
        await this._shutdown(code, reason, undefined, error);
      } else if (error instanceof TaskCancellationError) {
        // Task cancellation is expected during shutdown - log as debug, not critical
        logger.debug('receive loop cancelled', {
          connector: this.constructor.name,
          reason: error.message,
        });
        // Don't re-throw - this is normal during shutdown
      } else {
        logger.critical('unexpected_error_in recv_loop', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Credit Management
  // ---------------------------------------------------------------------

  /**
   * Emit credit update if flow control needs refill
   */
  private async _maybeEmitCredit(
    flowId: string,
    traceId?: string
  ): Promise<void> {
    if (!this._flowCtrl.needsRefill(flowId)) {
      return;
    }

    const delta = this._initialWindow;
    this._flowCtrl.addCredits(flowId, delta);

    const ackEnv = createFameEnvelope({
      ...(traceId && { traceId }),
      flowId,
      windowId: 0,
      frame: {
        type: 'CreditUpdate',
        flowId: flowId,
        credits: delta,
      } as CreditUpdateFrame,
      flags: FlowFlags.ACK,
    });

    await this.send(ackEnv);
  }

  // ---------------------------------------------------------------------
  // Shutdown Management
  // ---------------------------------------------------------------------

  /**
   * Shutdown the connector due to an error
   */
  private async _shutdownWithError(
    exc: Error,
    code = 1006,
    reason?: string
  ): Promise<void> {
    const errorReason = reason || `${exc.constructor.name}: ${exc.message}`;
    await this._shutdown(code, errorReason, undefined, exc);
  }

  /**
   * Internal shutdown implementation
   */
  private async _shutdown(
    code: number,
    reason: string,
    gracePeriod?: number,
    exc?: Error
  ): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._closeCode = code;
    this._closeReason = reason;

    // Use provided gracePeriod or fall back to configured value
    const effectiveGracePeriod = gracePeriod ?? this._shutdownGracePeriod;

    if (exc) {
      this._lastError = exc;
    }

    // Set final state if not already stopped/closed
    if (
      this._state !== ConnectorState.STOPPED &&
      this._state !== ConnectorState.CLOSED
    ) {
      this._setState(ConnectorState.CLOSED);
    }

    // Stop send loop using shutdown flag
    this._sendLoopShutdown = true;
    // Wake up the send loop if it's waiting
    if (this._sendPromiseResolve) {
      this._sendPromiseResolve();
      this._sendPromiseResolve = undefined;
    }

    // Close transport
    await this._transportClose(code, reason);

    // Shutdown spawned tasks
    try {
      await this.shutdownTasks({
        gracePeriod: effectiveGracePeriod * 1000, // Convert to milliseconds
        joinTimeout: this._shutdownJoinTimeout,
      });
    } catch (error) {
      logger.warning('task_shutdown_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Handle last spawner error
    if (this.lastSpawnerError) {
      this._lastError = this._lastError || this.lastSpawnerError;
    }

    // Resolve close promise
    if (this._closeResolver) {
      this._closeResolver();
    }
  }

  // ---------------------------------------------------------------------
  // Abstract Transport Methods (to be implemented by subclasses)
  // ---------------------------------------------------------------------

  /**
   * Send raw bytes through the transport
   */
  protected abstract _transportSendBytes(data: Uint8Array): Promise<void>;

  /**
   * Receive a message from the transport
   */
  protected abstract _transportReceive(): Promise<
    Uint8Array | FameEnvelope | FameChannelMessage | FameTransportClose
  >;

  /**
   * Close the underlying transport
   */
  protected async _transportClose(
    _code: number,
    _reason: string
  ): Promise<void> {
    // Default implementation does nothing - subclasses can override
  }
}
