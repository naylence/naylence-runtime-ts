import { createFameEnvelope, FlowFlags, generateId } from '@naylence/core';
import type {
  AllFramesUnion,
  CreateFameEnvelopeOptions,
  EnvelopeFactory,
  FameEnvelope,
  FameResponseType,
} from '@naylence/core';
import { getCurrentEnvelope } from '../util/envelope-context.js';

export class NodeEnvelopeFactory implements EnvelopeFactory {
  constructor(private readonly sidFn: () => string) {}

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

    const optionsRecord = isPlainRecord(options)
      ? (options as Record<string, unknown>)
      : {};

    validateFrame(frame);

    const sidValue = this.sidFn();
    const sanitizedSid =
      typeof sidValue === 'string' ? sidValue.trim() : sidValue;
    const idInput = pickAlias<string | null | undefined>(
      id ?? null,
      optionsRecord,
      'envelope_id'
    );
    const traceIdInput = pickAlias<string | null | undefined>(
      traceId ?? null,
      optionsRecord,
      'trace_id'
    );
    const toInput = pickAlias<FameEnvelope['to'] | string | null | undefined>(
      to ?? null,
      optionsRecord,
      'to',
      'recipient',
      'target',
      'address'
    );
    const capabilitiesInput = pickAlias<unknown>(
      capabilities ?? null,
      optionsRecord,
      'capabilities',
      'accepted_capabilities'
    );
    const replyToInput = pickAlias<
      FameEnvelope['replyTo'] | string | null | undefined
    >(
      replyTo ?? null,
      optionsRecord,
      'reply_to',
      'replyAddress',
      'reply_address'
    );
    const flowIdInput = pickAlias<string | null | undefined>(
      flowId ?? null,
      optionsRecord,
      'flow_id'
    );
    const windowIdInput = pickAlias<unknown>(
      windowId ?? null,
      optionsRecord,
      'window_id',
      'seq_id'
    );
    const flagsInput = pickAlias<unknown>(
      flags ?? null,
      optionsRecord,
      'flow_flags'
    );
    const timestampInput = pickAlias<unknown>(
      timestamp ?? null,
      optionsRecord,
      'timestamp',
      'ts'
    );
    const corrIdInput = pickAlias<string | null | undefined>(
      corrId ?? null,
      optionsRecord,
      'corr_id'
    );
    const responseTypeInput = pickAlias<unknown>(
      responseType ?? null,
      optionsRecord,
      'response_type',
      'rtype'
    );

    const sanitizedId =
      typeof idInput === 'string' ? idInput.trim() : undefined;
    const sanitizedTraceId =
      typeof traceIdInput === 'string' ? traceIdInput.trim() : undefined;
    const sanitizedFlowId =
      typeof flowIdInput === 'string' ? flowIdInput.trim() : undefined;
    const sanitizedCorrId =
      typeof corrIdInput === 'string' ? corrIdInput.trim() : undefined;

    const resolvedTraceId =
      sanitizedTraceId && sanitizedTraceId.length > 0
        ? sanitizedTraceId
        : (getCurrentEnvelope()?.trace_id ?? generateId());

    const normalizedCapabilities = normalizeCapabilities(capabilitiesInput);
    const normalizedWindowId = normalizeWindowId(windowIdInput);
    const normalizedTimestamp = normalizeTimestamp(timestampInput);
    const normalizedFlags = normalizeFlowFlags(flagsInput);
    const normalizedTo = sanitizeAddress(toInput);
    const normalizedReplyTo = sanitizeAddress(replyToInput);
    const normalizedResponseType = normalizeResponseType(responseTypeInput);

    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      traceId: resolvedTraceId,
      flags: normalizedFlags ?? FlowFlags.NONE,
      ...(normalizedTimestamp ? { timestamp: normalizedTimestamp } : {}),
    };

    if (sanitizedSid && sanitizedSid.length > 0) {
      envelopeOptions.sid = sanitizedSid;
    }
    if (sanitizedId && sanitizedId.length > 0) {
      envelopeOptions.id = sanitizedId;
    }
    if (normalizedTo !== undefined) {
      envelopeOptions.to = normalizedTo;
    }
    if (normalizedCapabilities !== undefined) {
      envelopeOptions.capabilities = normalizedCapabilities;
    }
    if (normalizedResponseType !== undefined) {
      envelopeOptions.responseType = normalizedResponseType;
    }
    if (normalizedReplyTo !== undefined) {
      envelopeOptions.replyTo = normalizedReplyTo;
    }
    if (sanitizedFlowId && sanitizedFlowId.length > 0) {
      envelopeOptions.flowId = sanitizedFlowId;
    }
    if (normalizedWindowId !== undefined) {
      envelopeOptions.windowId = normalizedWindowId;
    }
    if (sanitizedCorrId && sanitizedCorrId.length > 0) {
      envelopeOptions.corrId = sanitizedCorrId;
    }

    return createFameEnvelope(envelopeOptions);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickAlias<T>(
  primary: T | null | undefined,
  record: Record<string, unknown>,
  ...aliases: string[]
): T | null | undefined {
  if (primary !== undefined && primary !== null) {
    return primary;
  }

  for (const alias of aliases) {
    if (alias in record) {
      return record[alias] as T | null | undefined;
    }
  }

  return primary;
}

function validateFrame(frame: AllFramesUnion): void {
  if (!frame || typeof frame !== 'object') {
    throw new Error('NodeEnvelopeFactory requires a frame object');
  }

  const typeValue = (frame as { type?: unknown }).type;
  if (typeof typeValue !== 'string' || typeValue.trim().length === 0) {
    throw new Error('Envelope frame must include a non-empty type property');
  }
}

function normalizeCapabilities(capabilities: unknown): string[] | undefined {
  if (capabilities === undefined || capabilities === null) {
    return undefined;
  }

  let source: unknown[] | null = null;

  if (Array.isArray(capabilities)) {
    source = capabilities;
  } else if (typeof capabilities === 'string') {
    const segments = capabilities
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    source = segments;
  } else {
    return undefined;
  }

  const normalized = source
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : [];
}

function normalizeWindowId(windowId: unknown): number | undefined {
  if (windowId === undefined || windowId === null) {
    return undefined;
  }

  const numericValue =
    typeof windowId === 'number'
      ? windowId
      : typeof windowId === 'string'
        ? Number.parseFloat(windowId.trim())
        : Number(windowId);

  if (!Number.isFinite(numericValue)) {
    throw new Error('windowId must be a finite number');
  }

  const integerValue = Math.trunc(numericValue);
  if (integerValue < 0) {
    throw new Error('windowId must be a non-negative integer');
  }

  return integerValue;
}

function normalizeTimestamp(timestamp: unknown): Date | undefined {
  if (timestamp === undefined || timestamp === null) {
    return undefined;
  }

  if (timestamp instanceof Date) {
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error('timestamp must be a valid Date instance');
    }
    return timestamp;
  }

  if (typeof timestamp === 'string' || typeof timestamp === 'number') {
    const value = new Date(timestamp);
    if (Number.isNaN(value.getTime())) {
      throw new Error('timestamp must be a valid Date instance');
    }
    return value;
  }

  throw new Error('timestamp must be a Date, string, or number');
}

function sanitizeAddress(
  address: FameEnvelope['to'] | string | null | undefined
): FameEnvelope['to'] | string | undefined {
  if (address === null || address === undefined) {
    return undefined;
  }

  if (typeof address === 'string') {
    const trimmed = address.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return address;
}

function normalizeFlowFlags(flags: unknown): FlowFlags | undefined {
  if (flags === undefined || flags === null) {
    return undefined;
  }

  if (typeof flags === 'number' && Number.isInteger(flags)) {
    return flags as FlowFlags;
  }

  if (typeof flags === 'string' && flags.trim().length > 0) {
    const parsed = Number.parseInt(flags.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed as FlowFlags;
    }
  }

  throw new Error('flowFlags must be a finite integer value');
}

function normalizeResponseType(value: unknown): FameResponseType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0
      ? (trimmed as unknown as FameResponseType)
      : undefined;
  }

  return value as FameResponseType;
}
