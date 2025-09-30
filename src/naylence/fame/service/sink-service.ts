import { SINK_CAPABILITY, FameAddress, type FameRPCService } from "naylence-core";

export interface CreateSinkParams {
  name: string;
}

export interface SubscribeParams {
  sinkAddress: string;
  subscriberAddress: string;
}

export function isSinkService(service: unknown): service is SinkService {
  return Boolean(
    service &&
      typeof (service as SinkService).createSink === "function" &&
      typeof (service as SinkService).subscribe === "function" &&
      Array.isArray((service as SinkService).capabilities) &&
      (service as SinkService).capabilities.includes(SINK_CAPABILITY)
  );
}

export abstract class SinkService implements FameRPCService {
  readonly capabilities = [SINK_CAPABILITY];

  abstract createSink(params: CreateSinkParams): Promise<FameAddress>;

  abstract subscribe(params: SubscribeParams): Promise<void>;

  abstract handleRpcRequest(method: string, params: Record<string, any>): Promise<any>;
}
