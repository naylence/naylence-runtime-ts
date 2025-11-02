import { FameEnvelope, FameResponseType } from '@naylence/core';

export enum EnvelopeStatus {
  PENDING = 'pending',
  ACKED = 'acked',
  NACKED = 'nacked',
  RESPONDED = 'responded',
  STREAMING = 'streaming',
  TIMED_OUT = 'timed_out',
  FAILED = 'failed',
  RECEIVED = 'received',
  HANDLED = 'handled',
  FAILED_TO_HANDLE = 'failed_to_handle',
}

export enum MailboxType {
  INBOX = 'inbox',
  OUTBOX = 'outbox',
}

export interface TrackedEnvelopeInit {
  timeoutAtMs: number;
  overallTimeoutAtMs: number;
  expectedResponseType: FameResponseType;
  createdAtMs: number;
  attempt?: number;
  status?: EnvelopeStatus;
  meta?: Record<string, unknown>;
  insertedAtMs?: number;
  mailboxType?: MailboxType | null;
  originalEnvelope: FameEnvelope;
  serviceName?: string | null;
}

const LEGACY_STATUS_MAP: Record<string, EnvelopeStatus> = {
  pending: EnvelopeStatus.PENDING,
  acked: EnvelopeStatus.ACKED,
  nacked: EnvelopeStatus.NACKED,
  responded: EnvelopeStatus.RESPONDED,
  streaming: EnvelopeStatus.STREAMING,
  timed_out: EnvelopeStatus.TIMED_OUT,
  failed: EnvelopeStatus.FAILED,
  received: EnvelopeStatus.RECEIVED,
  handled: EnvelopeStatus.HANDLED,
  failed_to_handle: EnvelopeStatus.FAILED_TO_HANDLE,
};

const LEGACY_MAILBOX_MAP: Record<string, MailboxType> = {
  inbox: MailboxType.INBOX,
  outbox: MailboxType.OUTBOX,
};

export class TrackedEnvelope {
  public timeoutAtMs: number;
  public overallTimeoutAtMs: number;
  public expectedResponseType: FameResponseType;
  public createdAtMs: number;
  public attempt: number;
  public status: EnvelopeStatus;
  public readonly meta: Record<string, unknown>;
  public readonly insertedAtMs: number;
  public mailboxType: MailboxType | null;
  public readonly originalEnvelope: FameEnvelope;
  public serviceName: string | null;

  constructor(init: TrackedEnvelopeInit) {
    this.timeoutAtMs = init.timeoutAtMs;
    this.overallTimeoutAtMs = init.overallTimeoutAtMs;
    this.expectedResponseType = init.expectedResponseType;
    this.createdAtMs = init.createdAtMs;
    this.attempt = init.attempt ?? 0;
    this.status = normalizeStatus(init.status);
    this.meta = { ...(init.meta ?? {}) };
    this.insertedAtMs = init.insertedAtMs ?? Date.now();
    this.mailboxType = normalizeMailbox(init.mailboxType);
    this.originalEnvelope = init.originalEnvelope;
    this.serviceName = init.serviceName ?? null;
  }

  get envelopeId(): string {
    return this.originalEnvelope.id;
  }

  get correlationId(): string | null {
    return this.originalEnvelope.corrId ?? null;
  }

  get expectAck(): boolean {
    return Boolean(this.expectedResponseType & FameResponseType.ACK);
  }

  get expectReply(): boolean {
    return Boolean(this.expectedResponseType & FameResponseType.REPLY);
  }

  clone(overrides: Partial<TrackedEnvelopeInit> = {}): TrackedEnvelope {
    return new TrackedEnvelope({
      timeoutAtMs: overrides.timeoutAtMs ?? this.timeoutAtMs,
      overallTimeoutAtMs:
        overrides.overallTimeoutAtMs ?? this.overallTimeoutAtMs,
      expectedResponseType:
        overrides.expectedResponseType ?? this.expectedResponseType,
      createdAtMs: overrides.createdAtMs ?? this.createdAtMs,
      attempt: overrides.attempt ?? this.attempt,
      status: overrides.status ?? this.status,
      meta: overrides.meta ? { ...overrides.meta } : { ...this.meta },
      insertedAtMs: overrides.insertedAtMs ?? this.insertedAtMs,
      mailboxType: overrides.mailboxType ?? this.mailboxType,
      originalEnvelope: overrides.originalEnvelope ?? this.originalEnvelope,
      serviceName: overrides.serviceName ?? this.serviceName,
    });
  }
}

function normalizeStatus(status?: EnvelopeStatus): EnvelopeStatus {
  if (!status) {
    return EnvelopeStatus.PENDING;
  }
  if (typeof status === 'string' && LEGACY_STATUS_MAP[status]) {
    return LEGACY_STATUS_MAP[status];
  }
  return status;
}

function normalizeMailbox(
  mailbox: MailboxType | null | undefined
): MailboxType | null {
  if (!mailbox) {
    return mailbox ?? null;
  }
  if (typeof mailbox === 'string' && LEGACY_MAILBOX_MAP[mailbox]) {
    return LEGACY_MAILBOX_MAP[mailbox];
  }
  return mailbox;
}
