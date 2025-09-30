import { FameFabric } from "naylence-core";
import { RpcMixin, operation, createRpcProxy, RpcProxy } from "../rpc.js";

describe("RPC decorators and mixins", () => {
  class BaseService extends RpcMixin {
    baseHandler(): string {
      return "base";
    }
  }

  const baseDescriptor = Object.getOwnPropertyDescriptor(BaseService.prototype, "baseHandler")!;
  operation()(BaseService.prototype, "baseHandler", baseDescriptor);

  it("registers methods via direct decorator invocation", () => {
    class DirectService extends RpcMixin {
      direct(): string {
        return "direct";
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(DirectService.prototype, "direct")!;
    operation()(DirectService.prototype, "direct", descriptor);

    const entry = DirectService.rpcRegistry.get("direct");
    expect(entry).toEqual({ propertyKey: "direct", streaming: false });
  });

  it("registers methods with custom options and inherits parent registry", () => {
    class DerivedService extends BaseService {
      streamHandler(data: unknown): AsyncIterable<unknown> {
        return (async function* generator() {
          yield data;
        })();
      }
    }

    const streamDescriptor = Object.getOwnPropertyDescriptor(
      DerivedService.prototype,
      "streamHandler"
    )!;
    operation({ name: "stream.custom", streaming: true })(
      DerivedService.prototype,
      "streamHandler",
      streamDescriptor
    );

    const registry = DerivedService.rpcRegistry;
    expect(Array.from(registry.entries())).toEqual([
      ["baseHandler", { propertyKey: "baseHandler", streaming: false }],
      ["stream.custom", { propertyKey: "streamHandler", streaming: true }],
    ]);

    const baseRegistry = BaseService.rpcRegistry;
    expect(baseRegistry.has("stream.custom")).toBe(true);
  });

  it("throws when operation decorator is applied to non-function", () => {
    expect(() =>
      operation()({}, "notFunction", { value: 42 } as unknown as PropertyDescriptor)
    ).toThrow("@operation can only be applied to methods");
  });

  it("normalizes params and awaits non-streaming handlers", async () => {
    const captured: unknown[][] = [];

    class ParamService extends RpcMixin {
      regular(...args: unknown[]): number {
        captured.push(args);
        return args.length;
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(ParamService.prototype, "regular")!;
    operation()(ParamService.prototype, "regular", descriptor);

    const service = new ParamService();
    const result = await service.handleRpcRequest("regular", {
      args: [2, 3],
      kwargs: { extra: 5 },
    });

    expect(result).toBe(3);
    expect(captured[0]).toEqual([2, 3, { extra: 5 }]);

    await service.handleRpcRequest("regular", { plain: true } as unknown as Record<string, any>);
    expect(captured[1]).toEqual([{ plain: true }]);

    await service.handleRpcRequest("regular", undefined as unknown as Record<string, any>);
    expect(captured[2]).toEqual([]);
  });

  it("returns streaming handler results without awaiting", async () => {
    class StreamService extends RpcMixin {
      stream(): AsyncIterable<number> {
        return (async function* generator() {
          yield 1;
        })();
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(StreamService.prototype, "stream")!;
    operation({ streaming: true })(StreamService.prototype, "stream", descriptor);

    const service = new StreamService();
    const result = await service.handleRpcRequest("stream", {});
    expect(Symbol.asyncIterator in result).toBe(true);
  });

  it("throws for unknown methods and non-callable handlers", async () => {
    class ErrorService extends RpcMixin {
      method(): string {
        return "ok";
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(ErrorService.prototype, "method")!;
    operation()(ErrorService.prototype, "method", descriptor);

    const service = new ErrorService();
    await expect(service.handleRpcRequest("missing", {})).rejects.toThrow(
      "Unknown RPC method: missing"
    );

    (service as any).method = 123;
    await expect(service.handleRpcRequest("method", {})).rejects.toThrow(
      "RPC handler 'method' is not callable"
    );
  });
});

describe("RPC proxy wrapping", () => {
  const fabric = {
    invokeStream: jest.fn(async () => "streamed"),
    invokeByCapabilityStream: jest.fn(async () => "streamed-cap"),
  };

  const invoke = jest.fn(async () => "invoked");
  const invokeByCapability = jest.fn(async () => "invoked-cap");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("invokes address-bound RPC with positional args", async () => {
    const proxy = createRpcProxy({
      address: "svc://node",
      fabric,
      invoke,
      timeout: 2500,
    }) as any;

    const result = await proxy.add(1, 2);
    expect(result).toBe("invoked");
    expect(invoke).toHaveBeenCalledWith("svc://node", "add", { args: [1, 2] }, 2500);
  });

  it("invokes capability RPC with keyword params", async () => {
    const proxy = createRpcProxy({
      capabilities: ["math"],
      fabric,
      invokeByCapability,
      timeout: 1000,
    }) as any;

    const result = await proxy.sum({ x: 4, y: 5 });
    expect(result).toBe("invoked-cap");
    expect(invokeByCapability).toHaveBeenCalledWith(["math"], "sum", { x: 4, y: 5 }, 1000);
  });

  it("supports streaming invocations via address and capabilities", async () => {
    const addressProxy = createRpcProxy({
      address: "svc://stream",
      fabric,
      invoke,
      invokeByCapability,
      timeout: 3000,
    }) as any;

    await addressProxy.stream({ _stream: true });
    expect(fabric.invokeStream).toHaveBeenCalledWith("svc://stream", "stream", { args: [] }, 3000);

    const capProxy = createRpcProxy({
      capabilities: ["logs"],
      fabric,
      invoke,
      invokeByCapability,
      timeout: 4000,
    }) as any;

    await capProxy.stream({ payload: 1, _stream: true });
    expect(fabric.invokeByCapabilityStream).toHaveBeenCalledWith(
      ["logs"],
      "stream",
      { payload: 1 },
      4000
    );
  });

  it("falls back to FameFabric.current when no fabric is provided", async () => {
    const fallbackFabric = {
      invokeStream: jest.fn(async () => "fallback"),
      invokeByCapabilityStream: jest.fn(),
    };

    const currentSpy = jest
      .spyOn(FameFabric, "current")
      .mockReturnValue(fallbackFabric as unknown as FameFabric);

    try {
      const proxy = createRpcProxy({
        address: "svc://fallback",
        invoke,
        timeout: 1100,
      }) as any;

      await proxy.stream({ _stream: true });
      expect(fallbackFabric.invokeStream).toHaveBeenCalledWith(
        "svc://fallback",
        "stream",
        { args: [] },
        1100
      );
    } finally {
      currentSpy.mockRestore();
    }
  });

  it("removes stream flag and preserves additional positional arguments", async () => {
    const proxy = createRpcProxy({
      address: "svc://stream",
      fabric,
      invoke,
      timeout: 2000,
    }) as any;

    await proxy.items(42, { filter: "high", _stream: true });
    expect(fabric.invokeStream).toHaveBeenCalledWith(
      "svc://stream",
      "items",
      { args: [42, { filter: "high" }] },
      2000
    );
  });

  it("throws when proxy is not bound for streaming or standard calls", async () => {
    const proxy = createRpcProxy({ fabric, invoke, invokeByCapability }) as any;
    await expect(proxy.list()).rejects.toThrow(
      "RPC proxy must be bound to an address or capabilities"
    );
    await expect(proxy.list({ _stream: true })).rejects.toThrow(
      "RPC proxy must be bound to an address or capabilities"
    );
  });

  it("wraps RpcProxy instances and static constructors", async () => {
    const proxy = new RpcProxy({
      address: "svc://wrap",
      fabric,
      invoke,
      timeout: 1500,
    }) as any;

    await proxy.echo("hi");
    expect(invoke).toHaveBeenCalledWith("svc://wrap", "echo", { args: ["hi"] }, 1500);

    const staticAddress = RpcProxy.remoteByAddress("svc://static", {
      fabric,
      invoke,
      timeout: 1600,
    }) as any;
    await staticAddress.ping();
    expect(invoke).toHaveBeenLastCalledWith("svc://static", "ping", { args: [] }, 1600);

    const staticCaps = RpcProxy.remoteByCapabilities(["cap"], {
      fabric,
      invokeByCapability,
      timeout: 1700,
    }) as any;
    await staticCaps.fetch({ value: 1 });
    expect(invokeByCapability).toHaveBeenCalledWith(["cap"], "fetch", { value: 1 }, 1700);
  });
});
