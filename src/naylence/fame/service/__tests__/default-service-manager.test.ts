import {
  FameAddress,
  FameServiceProxy,
  type FameEnvelope,
  type FameMessageService,
  type FameRPCService,
  type FameService,
} from "naylence-core";

import { DefaultServiceManager } from "../default-service-manager.js";

const envelope = {
  version: "1.0",
  id: "env-1",
  frame: { type: "Data", payload: {} as any },
  ts: new Date().toISOString(),
} as unknown as FameEnvelope;

describe("DefaultServiceManager", () => {
  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  it("registers message services and wraps handler responses", async () => {
    const handleMessage = jest.fn(async () => undefined);
    const startFn = jest.fn(() => undefined);
    const service = {
      capabilities: ["alpha"],
      address: undefined as FameAddress | undefined,
      start: startFn,
      handleMessage,
    } as FameMessageService & { address?: FameAddress; start(): void };

    let servedHandler: ((env: FameEnvelope, ctx?: unknown) => Promise<unknown>) | undefined;
    let servedOptions: Record<string, unknown> | undefined;
    const servedAddress = FameAddress.create("service@/local");
    const serve = jest.fn(async (_name: string, handler, options) => {
      servedHandler = handler;
      servedOptions = options;
      return servedAddress;
    });
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve,
      serveRpc: jest.fn(),
      pollTimeoutMs: 500,
    });

    const address = await manager.registerService("calc", service);

    expect(startFn).toHaveBeenCalledTimes(1);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(servedOptions).toEqual({ capabilities: ["alpha"], pollTimeoutMs: 500 });
    expect(address).toBe(servedAddress);
    expect(service.address).toBe(servedAddress);

    const context = { trace: "ctx" };
    const handlerResult = await servedHandler!(envelope, context);
    expect(handlerResult).toBeNull();
    expect(handleMessage).toHaveBeenCalledWith(envelope, context);
  });

  it("registers rpc services without mutating predefined addresses", async () => {
    const rpcAddress = FameAddress.create("rpc@/endpoint");
    const service = {
      capabilities: undefined,
      address: FameAddress.create("existing@/address"),
      start: jest.fn(async () => undefined),
      handleRpcRequest: jest.fn(async () => "ok"),
    } as FameRPCService & { address: FameAddress; start(): Promise<void> };

    let servedOptions: Record<string, unknown> | undefined;
    const serveRpc = jest.fn(async (_name: string, handler, options) => {
      expect(await handler("ping", {})).toBe("ok");
      servedOptions = options;
      return rpcAddress;
    });

    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve: jest.fn(),
      serveRpc,
      pollTimeoutMs: null,
    });

    const address = await manager.registerService("rpc-service", service);

    expect(address).toBe(rpcAddress);
    expect(service.address.toString()).toBe("existing@/address");
    expect(servedOptions).toEqual({});
  });

  it("stops registered services and is idempotent", async () => {
    const stopFn = jest.fn(() => undefined);
    const service = {
      capabilities: ["beta"],
      stop: stopFn,
      handleMessage: jest.fn(async () => undefined),
    } as FameMessageService & { stop(): void };

    const serve = jest.fn(async () => FameAddress.create("service@/stop"));
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve,
      serveRpc: jest.fn(),
    });

    await manager.registerService("stoppable", service);

    await manager.stop();
    await manager.stop();

    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it("resolves capabilities from local services first", async () => {
    const serveAddress = FameAddress.create("service@/cap");
    const serve = jest.fn(async () => serveAddress);
    const invoke = jest.fn();
    const manager = new DefaultServiceManager({
      invoke,
      serve,
      serveRpc: jest.fn(),
    });

    const service: FameMessageService = {
      capabilities: ["gamma"],
      handleMessage: jest.fn(async () => undefined),
    };

    await manager.registerService("cap-service", service);

    const remoteInstance = { remote: true } as unknown as ReturnType<
      typeof FameServiceProxy.remoteByAddress
    >;
    const spy = jest.spyOn(FameServiceProxy, "remoteByAddress").mockReturnValue(remoteInstance);

    const resolved = manager.resolveByCapability("gamma");

    expect(spy).toHaveBeenCalledWith(serveAddress, { invoke });
    expect(resolved).toBe(remoteInstance);
  });

  it("falls back to configured capability map and throws when missing", () => {
    const mappedAddress = FameAddress.create("service@/mapped");
    const invoke = jest.fn();
    const manager = new DefaultServiceManager({
      invoke,
      serve: jest.fn(),
      serveRpc: jest.fn(),
      capabilityMap: { mapped: mappedAddress },
    });

    const remoteInstance = { remote: true } as unknown as ReturnType<
      typeof FameServiceProxy.remoteByAddress
    >;
    const spy = jest.spyOn(FameServiceProxy, "remoteByAddress").mockReturnValue(remoteInstance);

    const resolved = manager.resolveByCapability("mapped");
    expect(resolved).toBe(remoteInstance);
    expect(spy).toHaveBeenCalledWith(mappedAddress, { invoke });

    expect(() => manager.resolveByCapability("missing")).toThrow(
      "Capability missing not available"
    );
  });

  it("resolves addresses by capability for local and mapped services", async () => {
    const serveAddress = FameAddress.create("service@/resolver");
    const serve = jest.fn(async () => serveAddress);
    const mappedAddress = FameAddress.create("service@/mapped-only");
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve,
      serveRpc: jest.fn(),
      capabilityMap: new Map([["mapped-cap", mappedAddress]]),
    });

    const service: FameMessageService = {
      capabilities: ["delta", "epsilon"],
      handleMessage: jest.fn(async () => undefined),
    };

    await manager.registerService("cap-service", service);

    expect(await manager.resolveAddressByCapability(["delta", "epsilon"])).toBe(serveAddress);
    expect(await manager.resolveAddressByCapability(["mapped-cap"])).toBe(mappedAddress);
    expect(await manager.resolveAddressByCapability(["unknown"])).toBeNull();
  });

  it("treats explicit start calls as idempotent", async () => {
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve: jest.fn(),
      serveRpc: jest.fn(),
    });

    await manager.start();
    await expect(manager.start()).resolves.toBeUndefined();
  });

  it("skips stop hooks when services do not expose them", async () => {
    const serve = jest.fn(async () => FameAddress.create("service@/no-stop"));
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve,
      serveRpc: jest.fn(),
    });

    const service = {
      capabilities: ["theta"],
      handleMessage: jest.fn(async () => undefined),
    } as FameMessageService;

    await manager.registerService("nostop", service);
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("does not restart services when already running", async () => {
    const serve = jest.fn(async () => FameAddress.create("service@/already-started"));
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve,
      serveRpc: jest.fn(),
    });

    await manager.start();

    const service = {
      capabilities: ["lambda"],
      handleMessage: jest.fn(async () => undefined),
    } as FameMessageService;

    await manager.registerService("started", service);
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it("throws when registering unsupported services", async () => {
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve: jest.fn(),
      serveRpc: jest.fn(),
    });

    await expect(
      manager.registerService("invalid", { capabilities: [] } as FameService)
    ).rejects.toThrow("Service must implement FameMessageService or FameRPCService");
  });

  it("rejects non-string capability lookups", () => {
    const manager = new DefaultServiceManager({
      invoke: jest.fn(),
      serve: jest.fn(),
      serveRpc: jest.fn(),
    });

    expect(() => manager.resolveByCapability(Symbol("cap"))).toThrow(
      "Capability Symbol(cap) not available"
    );
  });
});
