import type {
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
} from '@naylence/core';

import { BaseNodeEventListener } from '../node/node-event-listener.js';
import type { NodeLike } from '../node/node-like.js';
import { getLogger } from '../util/logging.js';
import type {
  TraceEmitter,
  TraceSpan,
  TraceSpanOptions,
  TraceSpanScope,
} from './trace-emitter.js';

interface ActiveSpan {
  scope: TraceSpanScope;
  span: TraceSpan;
}

const telemetryLogger = getLogger('naylence.fame.telemetry.base_trace_emitter');

function logTelemetryFailure(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  telemetryLogger.warning(event, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : undefined,
  });
}

function buildEnvelopeAttributes(
  envelope: FameEnvelope
): Record<string, unknown> {
  return {
    'env.id': envelope.id,
    'env.trace_id': envelope.traceId,
    'env.corr_id': envelope.corrId,
    'env.flow_id': envelope.flowId,
    'env.seq_id': envelope.seqId,
    'env.to': envelope.to ?? null,
    'env.priority': envelope.priority ?? null,
    'env.sid': envelope.sid ?? null,
    'env.reply_to': envelope.replyTo ?? null,
    'env.ts': envelope.ts?.toISOString?.() ?? null,
    'env.frame_type': envelope.frame
      ? ((envelope.frame as { type?: string }).type ?? null)
      : null,
    'env.is_signed': Boolean(envelope.sec?.sig),
    'env.sign_kid': envelope.sec?.sig?.kid ?? null,
    'env.is_encrypted': Boolean(envelope.sec?.enc),
    'env.enc_kid': envelope.sec?.enc?.kid ?? null,
  };
}

function filterAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export abstract class BaseTraceEmitter
  extends BaseNodeEventListener
  implements TraceEmitter
{
  protected node: NodeLike | null = null;
  private readonly inflight = new Map<string, ActiveSpan>();

  public override readonly priority = 10_000;

  public abstract startSpan(
    name: string,
    options?: TraceSpanOptions
  ): TraceSpanScope;

  protected getSpanKey(envelope: FameEnvelope, operationKey: string): string {
    return `${envelope.id}:${operationKey}`;
  }

  protected startEnvelopeOperationSpan(
    node: NodeLike | null,
    operationName: string,
    envelope: FameEnvelope,
    operationKey: string,
    additionalAttributes: Record<string, unknown> | null = null
  ): FameEnvelope {
    try {
      const key = this.getSpanKey(envelope, operationKey);
      const previous = this.inflight.get(key);

      if (previous) {
        this.inflight.delete(key);
        try {
          previous.scope.exit();
        } catch (cleanupError) {
          logTelemetryFailure('trace_span_scope_exit_failed', cleanupError, {
            operation: operationName,
            span_key: key,
          });
        }
      }

      const attributes = buildEnvelopeAttributes(envelope);
      if (additionalAttributes) {
        for (const [attrKey, attrValue] of Object.entries(
          additionalAttributes
        )) {
          attributes[attrKey] = attrValue;
        }
      }

      const effectiveNode = node ?? this.node;
      if (effectiveNode) {
        attributes['node.id'] = effectiveNode.id;
        attributes['node.sid'] = effectiveNode.sid ?? null;
      }

      const scope = this.startSpan(operationName, {
        attributes: filterAttributes(attributes),
      });
      const span = scope.enter();

      this.inflight.set(key, { scope, span });
    } catch (error) {
      logTelemetryFailure('trace_span_start_failed', error, {
        operation: operationName,
        envelope_id: envelope.id,
      });
    }

    return envelope;
  }

  protected completeEnvelopeOperationSpan(
    node: NodeLike | null,
    operationName: string,
    envelope: FameEnvelope,
    operationKey: string,
    _result: unknown = null,
    error: unknown = null,
    additionalAttributes: Record<string, unknown> | null = null
  ): FameEnvelope {
    try {
      const key = this.getSpanKey(envelope, operationKey);
      let active = this.inflight.get(key);

      if (!active) {
        const attributes = buildEnvelopeAttributes(envelope);
        if (additionalAttributes) {
          for (const [attrKey, attrValue] of Object.entries(
            additionalAttributes
          )) {
            attributes[attrKey] = attrValue;
          }
        }

        const effectiveNode = node ?? this.node;
        if (effectiveNode) {
          attributes['node.id'] = effectiveNode.id;
          attributes['node.sid'] = effectiveNode.sid ?? null;
        }

        const scope = this.startSpan(operationName, {
          attributes: filterAttributes(attributes),
        });
        const span = scope.enter();
        active = { scope, span };
      } else {
        this.inflight.delete(key);
      }

      if (error !== null && error !== undefined) {
        try {
          active.span.recordException(error);
        } catch (recordError) {
          logTelemetryFailure(
            'trace_span_record_exception_failed',
            recordError,
            {
              operation: operationName,
              envelope_id: envelope.id,
            }
          );
        }
        try {
          const description =
            error instanceof Error ? error.message : String(error);
          active.span.setStatusError(description);
        } catch (statusError) {
          logTelemetryFailure('trace_span_set_status_failed', statusError, {
            operation: operationName,
            envelope_id: envelope.id,
          });
        }
      }

      try {
        active.scope.exit();
      } catch (exitError) {
        logTelemetryFailure('trace_span_scope_exit_failed', exitError, {
          operation: operationName,
          envelope_id: envelope.id,
        });
      }
    } catch (error) {
      logTelemetryFailure('trace_span_complete_failed', error, {
        operation: operationName,
        envelope_id: envelope.id,
      });
    }

    return envelope;
  }

  public override async onEnvelopeReceived(
    node: NodeLike,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    try {
      const attributes = buildEnvelopeAttributes(envelope);
      attributes['node.id'] = node.id;
      attributes['node.sid'] = node.sid ?? null;

      if (context?.fromSystemId) {
        attributes['from.node_id'] = context.fromSystemId;
      }

      if (context?.originType) {
        attributes['from.origin_type'] = context.originType;
      }

      const scope = this.startSpan('env.received', {
        attributes: filterAttributes(attributes),
      });
      scope.enter();
      scope.exit();
    } catch (error) {
      logTelemetryFailure('trace_span_received_failed', error, {
        envelope_id: envelope.id,
      });
    }

    return envelope;
  }

  public override async onForwardToRoute(
    node: NodeLike,
    nextSegment: string,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    return this.startEnvelopeOperationSpan(
      node,
      'env.fwd_to_route',
      envelope,
      nextSegment,
      {
        'route.segment': nextSegment,
      }
    );
  }

  public override async onForwardToRouteComplete(
    node: NodeLike,
    nextSegment: string,
    envelope: FameEnvelope,
    result?: unknown,
    error?: Error,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    return this.completeEnvelopeOperationSpan(
      node,
      'env.fwd_to_route',
      envelope,
      nextSegment,
      result,
      error,
      {
        'route.segment': nextSegment,
      }
    );
  }

  public override async onForwardUpstream(
    node: NodeLike,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    return this.startEnvelopeOperationSpan(
      node,
      'env.fwd_upstream',
      envelope,
      'upstream',
      {
        direction: 'upstream',
      }
    );
  }

  public override async onForwardUpstreamComplete(
    node: NodeLike,
    envelope: FameEnvelope,
    result?: unknown,
    error?: Error,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    return this.completeEnvelopeOperationSpan(
      node,
      'env.fwd_upstream',
      envelope,
      'upstream',
      result,
      error,
      {
        direction: 'upstream',
      }
    );
  }

  public override async onForwardToPeer(
    node: NodeLike,
    peerSegment: string,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    return this.startEnvelopeOperationSpan(
      node,
      'env.fwd_to_peer',
      envelope,
      peerSegment,
      {
        'peer.segment': peerSegment,
      }
    );
  }

  public override async onForwardToPeerComplete(
    node: NodeLike,
    peerSegment: string,
    envelope: FameEnvelope,
    result?: unknown,
    error?: Error,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    return this.completeEnvelopeOperationSpan(
      node,
      'env.fwd_to_peer',
      envelope,
      peerSegment,
      result,
      error,
      {
        'peer.segment': peerSegment,
      }
    );
  }

  public override async onDeliverLocal(
    node: NodeLike,
    address: FameAddress,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    const addressKey = address ? String(address) : 'unknown';
    return this.startEnvelopeOperationSpan(
      node,
      'env.deliver_local',
      envelope,
      addressKey,
      {
        'delivery.address': addressKey,
        'delivery.type': 'local',
      }
    );
  }

  public async onDeliverLocalComplete(
    node: NodeLike,
    address: FameAddress,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<FameEnvelope | null> {
    const addressKey = address ? String(address) : 'unknown';
    return this.completeEnvelopeOperationSpan(
      node,
      'env.deliver_local',
      envelope,
      addressKey,
      null,
      null,
      {
        'delivery.address': addressKey,
        'delivery.type': 'local',
      }
    );
  }

  public override async onNodeInitialized(node: NodeLike): Promise<void> {
    this.node = node;
  }

  public override async onNodeStopped(_node: NodeLike): Promise<void> {
    try {
      if (typeof this.flush === 'function') {
        await this.flush();
      }
      if (typeof this.shutdown === 'function') {
        await this.shutdown();
      }
    } catch (error) {
      logTelemetryFailure('trace_span_shutdown_failed', error);
    }
  }

  public async flush(): Promise<void> {
    // Default implementation: no-op
  }

  public async shutdown(): Promise<void> {
    // Default implementation: no-op
  }
}
