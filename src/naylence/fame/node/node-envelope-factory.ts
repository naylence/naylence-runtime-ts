import { createFameEnvelope, FlowFlags, generateId } from 'naylence-core';
import type {
  AllFramesUnion,
  CreateFameEnvelopeOptions,
  EnvelopeFactory,
  FameEnvelope,
  FameResponseType,
} from 'naylence-core';
import { getCurrentEnvelope } from '../util/envelope-context.js';

export class NodeEnvelopeFactory implements EnvelopeFactory {
  constructor(
    private readonly sidFn: () => string
  ) {}

  createEnvelope(options: {
    frame: AllFramesUnion;
    id?: string;
    traceId?: string;
    to?: FameEnvelope['to'] | string | null;
    capabilities?: string[] | null;
    replyTo?: FameEnvelope['replyTo'] | null;
    flowId?: string | null;
    windowId?: number | null;
    flags?: FlowFlags | null;
    timestamp?: Date;
    corrId?: string | null;
    responseType?: FameResponseType | null;
  }): FameEnvelope {
    const {
      frame,
      id,
      traceId,
      to,
      capabilities,
      replyTo,
      flowId,
      windowId,
      flags,
      timestamp,
      corrId,
      responseType,
    } = options;

    const sid = this.sidFn();
    const resolvedTraceId = traceId ?? getCurrentEnvelope()?.trace_id ?? generateId();

    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      traceId: resolvedTraceId,
      windowId: windowId ?? 0,
      flags: flags ?? FlowFlags.NONE,
      timestamp: timestamp ?? new Date(),
    };

    if (sid) {
      envelopeOptions.sid = sid;
    }
    if (id) {
      envelopeOptions.id = id;
    }
    if (to !== undefined && to !== null) {
      envelopeOptions.to = to as NonNullable<typeof to>;
    }
    if (capabilities !== undefined && capabilities !== null) {
      envelopeOptions.capabilities = capabilities;
    }
    if (responseType !== undefined && responseType !== null) {
      envelopeOptions.responseType = responseType;
    }
    if (replyTo !== undefined && replyTo !== null) {
      envelopeOptions.replyTo = replyTo as NonNullable<typeof replyTo>;
    }
    if (flowId !== undefined && flowId !== null) {
      envelopeOptions.flowId = flowId;
    }
    if (corrId !== undefined && corrId !== null) {
      envelopeOptions.corrId = corrId;
    }

    return createFameEnvelope(envelopeOptions);
  }
}
