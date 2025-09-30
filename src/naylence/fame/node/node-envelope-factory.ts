import { createFameEnvelope, FlowFlags, generateId } from "naylence-core";
import type {
  AllFramesUnion,
  CreateFameEnvelopeOptions,
  EnvelopeFactory,
  FameEnvelope,
  FameResponseType,
} from "naylence-core";
import { getCurrentEnvelope } from "../util/envelope-context.js";

export class NodeEnvelopeFactory implements EnvelopeFactory {
  constructor(private readonly sidFn: () => string) {}

  createEnvelope(options: {
    frame: AllFramesUnion;
    id?: string;
    traceId?: string;
    to?: FameEnvelope["to"] | string | null;
    capabilities?: string[] | null;
    replyTo?: FameEnvelope["replyTo"] | null;
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

    validateFrame(frame);

    const sidValue = this.sidFn();
    const sanitizedSid = typeof sidValue === "string" ? sidValue.trim() : sidValue;
    const sanitizedId = typeof id === "string" ? id.trim() : id;
    const sanitizedTraceId = typeof traceId === "string" ? traceId.trim() : traceId;
    const sanitizedFlowId = typeof flowId === "string" ? flowId.trim() : flowId;
    const sanitizedCorrId = typeof corrId === "string" ? corrId.trim() : corrId;

    const resolvedTraceId =
      sanitizedTraceId && sanitizedTraceId.length > 0
        ? sanitizedTraceId
        : (getCurrentEnvelope()?.trace_id ?? generateId());

    const normalizedCapabilities = normalizeCapabilities(capabilities ?? undefined);
    const normalizedWindowId = normalizeWindowId(windowId ?? undefined);
    const normalizedTimestamp = normalizeTimestamp(timestamp ?? undefined);
    const normalizedTo = sanitizeAddress(to);
    const normalizedReplyTo = sanitizeAddress(replyTo);

    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      traceId: resolvedTraceId,
      flags: flags ?? FlowFlags.NONE,
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
    if (responseType !== undefined && responseType !== null) {
      envelopeOptions.responseType = responseType;
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

function validateFrame(frame: AllFramesUnion): void {
  if (!frame || typeof frame !== "object") {
    throw new Error("NodeEnvelopeFactory requires a frame object");
  }

  const typeValue = (frame as { type?: unknown }).type;
  if (typeof typeValue !== "string" || typeValue.trim().length === 0) {
    throw new Error("Envelope frame must include a non-empty type property");
  }
}

function normalizeCapabilities(capabilities?: string[] | null): string[] | undefined {
  if (!capabilities) {
    return undefined;
  }

  const normalized = capabilities
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : [];
}

function normalizeWindowId(windowId?: number | null): number | undefined {
  if (windowId === undefined || windowId === null) {
    return undefined;
  }

  if (!Number.isFinite(windowId)) {
    throw new Error("windowId must be a finite number");
  }

  const integerValue = Math.trunc(windowId);
  if (integerValue < 0) {
    throw new Error("windowId must be a non-negative integer");
  }

  return integerValue;
}

function normalizeTimestamp(timestamp?: Date | null): Date | undefined {
  if (!timestamp) {
    return undefined;
  }

  const value = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    throw new Error("timestamp must be a valid Date instance");
  }

  return value;
}

function sanitizeAddress(
  address: FameEnvelope["to"] | string | null | undefined
): FameEnvelope["to"] | string | undefined {
  if (address === null || address === undefined) {
    return undefined;
  }

  if (typeof address === "string") {
    const trimmed = address.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return address;
}
