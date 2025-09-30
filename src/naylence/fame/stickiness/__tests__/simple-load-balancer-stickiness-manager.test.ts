import type { FameEnvelope, Stickiness } from "naylence-core";

import { LoadBalancerStickinessManagerFactory } from "../load-balancer-stickiness-manager-factory.js";
import * as StickinessExports from "../index.js";
import { ReplicaStickinessManagerFactory } from "../replica-stickiness-manager-factory.js";
import { SimpleLoadBalancerStickinessManager } from "../simple-load-balancer-stickiness-manager.js";
import {
  SimpleLoadBalancerStickinessManagerFactory,
  type SimpleLoadBalancerStickinessManagerConfig,
} from "../simple-load-balancer-stickiness-manager-factory.js";

describe("SimpleLoadBalancerStickinessManager", () => {
  const enabledConfig: SimpleLoadBalancerStickinessManagerConfig = {
    type: "SimpleLoadBalancerStickinessManager",
  };

  function createEnvelope(overrides: Partial<FameEnvelope> = {}): FameEnvelope {
    return {
      id: overrides.id ?? "env-1",
      sid: overrides.sid,
      aft: overrides.aft,
      frame: overrides.frame ?? { type: "Data", payload: {} },
    } as FameEnvelope;
  }

  function computeDeterministicIndex(key: string, modulo: number): number {
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return modulo === 0 ? 0 : hash % modulo;
  }

  it("advertises attribute mode when enabled and child provides no offer", () => {
    const manager = new SimpleLoadBalancerStickinessManager(enabledConfig);

    const result = manager.negotiate(null);

    expect(result).toEqual({ enabled: true, mode: "attr", version: 1 });
  });

  it("returns null when disabled and no child offer is provided", () => {
    const manager = new SimpleLoadBalancerStickinessManager(null);

    const result = manager.negotiate(null);

    expect(result).toBeNull();
  });

  it("disables stickiness when config is absent and child advertises", () => {
    const manager = new SimpleLoadBalancerStickinessManager(null);
    const offer: Stickiness = { mode: "attr", version: 2 };

    const result = manager.negotiate(offer);

    expect(result).toEqual({ enabled: false, version: 2 });
  });

  it("selects attribute mode when supported by child", () => {
    const manager = new SimpleLoadBalancerStickinessManager(enabledConfig);
    const offer: Stickiness = { supportedModes: ["aft", "attr"], version: 3 };

    const result = manager.negotiate(offer);

    expect(result).toEqual({ enabled: true, mode: "attr", version: 3 });
  });

  it("explicitly disables when no compatible mode exists", () => {
    const manager = new SimpleLoadBalancerStickinessManager(enabledConfig);
    const offer: Stickiness = { supportedModes: ["aft"], version: 4 };

    const result = manager.negotiate(offer);

    expect(result).toEqual({ enabled: false, version: 4 });
  });

  it("returns null routing when stickiness disabled locally", () => {
    const manager = new SimpleLoadBalancerStickinessManager(null);
    const envelope = createEnvelope({ sid: "sid-1" });

    const result = manager.getStickyReplicaSegment(envelope, ["seg-a", "seg-b"]);

    expect(result).toBeNull();
  });

  it("chooses deterministic segment based on SID hash", () => {
    const manager = new SimpleLoadBalancerStickinessManager(enabledConfig);
    const segments = ["seg-a", "seg-b", "seg-c"];
    const sid = "sid-123";
    const envelope = createEnvelope({ sid });

    const expected = segments[computeDeterministicIndex(sid, segments.length)];

    const result = manager.getStickyReplicaSegment(envelope, segments);

    expect(result).toBe(expected);
  });

  it("falls back to default routing when SID or segments missing", () => {
    const manager = new SimpleLoadBalancerStickinessManager(enabledConfig);
    const envelopeWithoutSid = createEnvelope({ id: "env-no-sid", sid: undefined });
    const envelopeWithoutSegments = createEnvelope({ id: "env-no-segments", sid: "sid-2" });

    expect(manager.getStickyReplicaSegment(envelopeWithoutSid, ["seg-a"])).toBeNull();
    expect(manager.getStickyReplicaSegment(envelopeWithoutSegments, null)).toBeNull();
  });

  it("falls back when segments list is empty even with SID present", () => {
    const manager = new SimpleLoadBalancerStickinessManager(enabledConfig);
    const envelope = createEnvelope({ sid: "sid-empty" });

    expect(manager.getStickyReplicaSegment(envelope, [])).toBeNull();
  });

  it("returns zero index when modulo is zero in deterministic hash", () => {
    const computeDeterministicIndex = (
      SimpleLoadBalancerStickinessManager as unknown as {
        computeDeterministicIndex(key: string, modulo: number): number;
      }
    ).computeDeterministicIndex;

    const index = computeDeterministicIndex("sid-empty", 0);

    expect(index).toBe(0);
  });
});

describe("SimpleLoadBalancerStickinessManagerFactory", () => {
  it("creates instances from config objects", async () => {
    const factory = new SimpleLoadBalancerStickinessManagerFactory();

    const manager = await factory.create({});

    expect(manager).toBeInstanceOf(SimpleLoadBalancerStickinessManager);
  });

  it("creates default simple manager when no config provided", async () => {
    const manager =
      await LoadBalancerStickinessManagerFactory.createLoadBalancerStickinessManager();

    expect(manager).toBeInstanceOf(SimpleLoadBalancerStickinessManager);
  });

  it("creates explicit simple manager when type provided", async () => {
    const manager = await LoadBalancerStickinessManagerFactory.createLoadBalancerStickinessManager({
      type: "SimpleLoadBalancerStickinessManager",
    });

    expect(manager).toBeInstanceOf(SimpleLoadBalancerStickinessManager);
  });
});

describe("ReplicaStickinessManagerFactory", () => {
  it("returns null when no default factory is registered", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const manager = await ReplicaStickinessManagerFactory.createReplicaStickinessManager();

    expect(manager).toBeNull();

    warnSpy.mockRestore();
  });

  it("throws when requesting unknown replica type", async () => {
    await expect(
      ReplicaStickinessManagerFactory.createReplicaStickinessManager({
        type: "UnknownReplicaStickinessManager",
      })
    ).rejects.toThrow("Unknown factory type");
  });
});

describe("stickiness index exports", () => {
  it("re-exports the simple load balancer manager", () => {
    expect(StickinessExports.SimpleLoadBalancerStickinessManager).toBe(
      SimpleLoadBalancerStickinessManager
    );
  });
});
