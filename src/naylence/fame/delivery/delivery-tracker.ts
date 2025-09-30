import { FameDeliveryContext, FameEnvelope, FameResponseType } from "naylence-core";
import type { DeliveryAckFrame } from "naylence-core";

export class AckTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AckTimeoutError";
  }
}

interface PendingAck {
  resolve: (envelope: FameEnvelope) => void;
  reject: (error: Error) => void;
  promise: Promise<FameEnvelope>;
  timer: ReturnType<typeof setTimeout> | null;
  expectedResponseType: FameResponseType;
}

export interface TrackOptions {
  timeoutMs: number;
  expectedResponseType: FameResponseType;
}

export class DeliveryTracker {
  private readonly pending = new Map<string, PendingAck>();
  private readonly aliases = new Map<string, string>();

  async track(envelope: FameEnvelope, options: TrackOptions): Promise<void> {
    if (this.pending.has(envelope.id)) {
      throw new Error(`Envelope ${envelope.id} is already being tracked`);
    }

    const { timeoutMs, expectedResponseType } = options;

    const pending: Partial<PendingAck> = { expectedResponseType };

    pending.promise = new Promise<FameEnvelope>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });

    pending.timer = setTimeout(() => {
      this.pending.delete(envelope.id);
      pending.reject?.(
        new AckTimeoutError(`Timeout waiting for response to envelope ${envelope.id}`)
      );
    }, timeoutMs);

    this.pending.set(envelope.id, pending as PendingAck);
    if (envelope.corrId) {
      this.aliases.set(envelope.corrId, envelope.id);
    }
  }

  async awaitAck(envelopeId: string): Promise<FameEnvelope> {
    const entry = this.pending.get(this.resolveKey(envelopeId));
    if (!entry) {
      throw new Error(`No pending envelope with id ${envelopeId}`);
    }
    return entry.promise;
  }

  async onEnvelopeDelivered(
    _inbox: string,
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<void> {
    const entryKey = this.resolveEnvelopeKey(envelope);
    if (!entryKey) {
      return;
    }

    const entry = this.pending.get(entryKey);
    if (!entry) {
      return;
    }

    if (!(entry.expectedResponseType & FameResponseType.ACK)) {
      return;
    }

    const isAckFrame = Boolean(
      envelope.frame && typeof envelope.frame === "object" && "type" in envelope.frame
    );

    if (!isAckFrame) {
      return;
    }

    const frame = envelope.frame as DeliveryAckFrame;
    if (!frame.type.endsWith("Ack")) {
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.pending.delete(entryKey);
    this.removeAliases(entryKey);
    entry.resolve(envelope);
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(new AckTimeoutError("Tracker cleared before response arrived"));
    }
    this.pending.clear();
    this.aliases.clear();
  }

  private resolveKey(key: string): string {
    return this.aliases.get(key) ?? key;
  }

  private resolveEnvelopeKey(envelope: FameEnvelope): string | null {
    const candidates = new Set<string>();
    if (envelope.corrId) {
      candidates.add(envelope.corrId);
    }
    if (envelope.id) {
      candidates.add(envelope.id);
    }
    const frame = envelope.frame as Partial<DeliveryAckFrame> | undefined;
    if (frame && typeof frame === "object" && frame.refId) {
      candidates.add(frame.refId);
    }

    for (const candidate of candidates) {
      const key = this.resolveKey(candidate);
      if (this.pending.has(key)) {
        return key;
      }
    }

    return null;
  }

  private removeAliases(primaryKey: string): void {
    for (const [alias, key] of this.aliases.entries()) {
      if (key === primaryKey) {
        this.aliases.delete(alias);
      }
    }
  }
}
