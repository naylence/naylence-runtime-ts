import { FameFabric, FameServiceProxy, type FameServiceProxyOptions } from 'naylence-core';

const RPC_REGISTRY = Symbol('naylence.rpc.registry');

type RpcRegistryEntry = { propertyKey: string; streaming: boolean };

type RpcRegistry = Map<string, RpcRegistryEntry>;

type RpcDecorator = (
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor
) => void;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.prototype.toString.call(value) === '[object Object]'
  );
}

function getOrCreateRegistry(ctor: any): RpcRegistry {
  if (!ctor[RPC_REGISTRY]) {
    const parentRegistry: RpcRegistry | undefined = ctor.__proto__?.[RPC_REGISTRY];
    ctor[RPC_REGISTRY] = parentRegistry
      ? new Map(parentRegistry)
      : new Map<string, RpcRegistryEntry>();
  }
  return ctor[RPC_REGISTRY] as RpcRegistry;
}

function normalizeParams(params: any): { positional: any[]; keyword: Record<string, any> } {
  if (!params || typeof params !== 'object') {
    return { positional: [], keyword: {} };
  }

  const positional = Array.isArray(params.args) ? [...params.args] : [];
  const keyword = isPlainObject(params.kwargs) ? { ...params.kwargs } : {};

  if (positional.length === 0 && Object.keys(keyword).length === 0 && isPlainObject(params)) {
    return { positional: [], keyword: { ...params } };
  }

  return { positional, keyword };
}

export interface OperationOptions {
  name?: string;
  streaming?: boolean;
}

export function operation(): RpcDecorator;
export function operation(options: OperationOptions): RpcDecorator;
export function operation(
  targetOrOptions?: object | OperationOptions,
  propertyKey?: string | symbol,
  descriptor?: PropertyDescriptor
): RpcDecorator | void {
  if (typeof propertyKey === 'string' || typeof propertyKey === 'symbol') {
    const decorator = createDecorator();
    decorator(targetOrOptions as object, propertyKey, descriptor!);
    return;
  }

  const options = (targetOrOptions ?? {}) as OperationOptions;
  return createDecorator(options);
}

function createDecorator(options: OperationOptions = {}): RpcDecorator {
  return (target, propertyKey, descriptor) => {
    if (!descriptor || typeof descriptor.value !== 'function') {
      throw new TypeError('@operation can only be applied to methods');
    }

    const ctor = target.constructor;
    const registry = getOrCreateRegistry(ctor);
    const rpcName = options.name ?? (propertyKey as string);

    registry.set(rpcName, {
      propertyKey: propertyKey as string,
      streaming: Boolean(options.streaming),
    });
  };
}

export abstract class RpcMixin {
  static get rpcRegistry(): ReadonlyMap<string, RpcRegistryEntry> {
    return getOrCreateRegistry(this);
  }

  protected getRpcRegistry(): ReadonlyMap<string, RpcRegistryEntry> {
    return (this.constructor as typeof RpcMixin).rpcRegistry;
  }

  async handleRpcRequest(method: string, params: Record<string, any>): Promise<any> {
    const registry = this.getRpcRegistry();
    const entry = registry.get(method);

    if (!entry) {
      throw new Error(`Unknown RPC method: ${method}`);
    }

    const handler: any = (this as any)[entry.propertyKey];
    if (typeof handler !== 'function') {
      throw new TypeError(`RPC handler '${entry.propertyKey}' is not callable`);
    }

    const { positional, keyword } = normalizeParams(params);
    const args: any[] = [...positional];

    if (Object.keys(keyword).length > 0) {
      args.push(keyword);
    }

    try {
      const result = handler.apply(this, args);
      if (entry.streaming) {
        return result;
      }
      return await result;
    } catch (error) {
      throw error;
    }
  }
}

function extractStreamFlag(args: any[]): { stream: boolean; args: any[] } {
  if (args.length === 0) {
    return { stream: false, args };
  }

  const last = args[args.length - 1];
  if (isPlainObject(last) && Object.prototype.hasOwnProperty.call(last, '_stream')) {
    const { _stream, ...rest } = last;
    const cleanedArgs = [...args.slice(0, -1)];
    if (Object.keys(rest).length > 0) {
      cleanedArgs.push(rest);
    }
    return { stream: Boolean(_stream), args: cleanedArgs };
  }

  if (args.length === 1 && isPlainObject(args[0]) && Object.prototype.hasOwnProperty.call(args[0], '_stream')) {
    const { _stream, ...rest } = args[0];
    return { stream: Boolean(_stream), args: Object.keys(rest).length ? [rest] : [] };
  }

  return { stream: false, args };
}

function wrapRpcProxy<T extends FameServiceProxy>(target: T): T {
  return new Proxy(target, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !prop.startsWith('_') && !(prop in target)) {
        return async (...rawArgs: any[]) => {
          const { stream, args } = extractStreamFlag(rawArgs);

          let params: Record<string, any>;
          if (args.length === 1 && isPlainObject(args[0])) {
            params = args[0];
          } else {
            params = { args };
          }

          const internal: any = target;
          const timeout: number = internal._timeout;

          if (stream) {
            const fabric = internal._fabric || FameFabric.current();
            if (internal._address) {
              return await fabric.invokeStream(internal._address, prop, params, timeout);
            }
            if (internal._capabilities) {
              return await fabric.invokeByCapabilityStream(internal._capabilities, prop, params, timeout);
            }
            throw new Error('RPC proxy must be bound to an address or capabilities');
          }

          if (internal._address) {
            return await internal._invoke(internal._address, prop, params, timeout);
          }

          if (internal._capabilities) {
            return await internal._invokeByCapability(internal._capabilities, prop, params, timeout);
          }

          throw new Error('RPC proxy must be bound to an address or capabilities');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

export function createRpcProxy(options: FameServiceProxyOptions): any {
  const base = new FameServiceProxy(options);
  return wrapRpcProxy(base);
}

export class RpcProxy extends FameServiceProxy {
  constructor(options: FameServiceProxyOptions = {}) {
    super(options);
    return wrapRpcProxy(this);
  }

  static remoteByAddress(
    address: Parameters<typeof FameServiceProxy.remoteByAddress>[0],
    options: Omit<FameServiceProxyOptions, 'address'> = {}
  ): RpcProxy {
    const proxy = FameServiceProxy.remoteByAddress(address, options);
    return wrapRpcProxy(proxy as FameServiceProxy) as RpcProxy;
  }

  static remoteByCapabilities(
    capabilities: Parameters<typeof FameServiceProxy.remoteByCapabilities>[0],
    options: Omit<FameServiceProxyOptions, 'capabilities'> = {}
  ): RpcProxy {
    const proxy = FameServiceProxy.remoteByCapabilities(capabilities, options);
    return wrapRpcProxy(proxy as FameServiceProxy) as RpcProxy;
  }
}
