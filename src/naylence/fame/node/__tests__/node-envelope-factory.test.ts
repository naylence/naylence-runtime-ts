import { FameResponseType, FlowFlags } from "naylence-core";
import { withEnvelopeContext } from "../../util/envelope-context.js";
import { NodeEnvelopeFactory } from "../node-envelope-factory.js";

describe("NodeEnvelopeFactory", () => {
  const frame = { type: "NodeHeartbeat", systemId: "node-1" } as const;

  it("sanitizes and normalizes envelope fields", () => {
    const timestamp = new Date("2024-01-01T00:00:00.000Z");
    const factory = new NodeEnvelopeFactory(() => "  sid-value  ");

    const envelope = factory.createEnvelope({
      frame,
      id: "  env-id  ",
      traceId: "  trace-123  ",
      to: "  service@test/path  ",
      capabilities: ["  cap.one  ", " ", "cap.two"],
      replyTo: "  reply@test/path  ",
      flowId: "  flow-1  ",
      windowId: 3.6,
      flags: FlowFlags.ACK,
      timestamp,
      corrId: "  corr-123  ",
      responseType: FameResponseType.ACK,
    });

    expect(envelope.sid).toBe("sid-value");
    expect(envelope.id).toBe("env-id");
    expect(envelope.traceId).toBe("trace-123");
    expect(String(envelope.to)).toBe("service@test/path");
    expect(envelope.capabilities).toEqual(["cap.one", "cap.two"]);
    expect(String(envelope.replyTo)).toBe("reply@test/path");
    expect(envelope.flowId).toBe("flow-1");
    expect(envelope.seqId).toBe(3);
    expect(envelope.flowFlags).toBe(FlowFlags.ACK);
    expect(envelope.ts.toISOString()).toBe(timestamp.toISOString());
    expect(envelope.corrId).toBe("corr-123");
    expect(envelope.rtype).toBe(FameResponseType.ACK);
  });

  it("defaults trace id from envelope context when omitted", () => {
    const factory = new NodeEnvelopeFactory(() => "sid");
    const result = withEnvelopeContext({ trace_id: "context-trace", id: "context-id" }, () =>
      factory.createEnvelope({
        frame,
      })
    );

    expect(result.traceId).toBe("context-trace");
  });

  it("rejects frames without a type", () => {
    const factory = new NodeEnvelopeFactory(() => "sid");

    expect(() =>
      factory.createEnvelope({
        frame: { type: "" } as any,
      })
    ).toThrow("Envelope frame must include a non-empty type property");
  });

  it("rejects negative window ids", () => {
    const factory = new NodeEnvelopeFactory(() => "sid");

    expect(() =>
      factory.createEnvelope({
        frame,
        windowId: -1,
      })
    ).toThrow("windowId must be a non-negative integer");
  });
});
