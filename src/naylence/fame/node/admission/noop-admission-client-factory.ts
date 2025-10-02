import {
  ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  AdmissionClientFactory,
  type AdmissionConfig,
} from "./admission-client-factory.js";
import { NoopAdmissionClient, type NoopAdmissionClientOptions } from "./noop-admission-client.js";
import type { AdmissionClient } from "./admission-client.js";

export interface NoopAdmissionClientConfig extends AdmissionConfig {
  type: "NoopAdmissionClient";
  systemId?: string;
  autoAcceptLogicals?: boolean;
}

export const FACTORY_META = {
  base: ADMISSION_CLIENT_FACTORY_BASE_TYPE,
  key: "NoopAdmissionClient",
} as const;

export class NoopAdmissionClientFactory extends AdmissionClientFactory<NoopAdmissionClientConfig> {
  public readonly type = "NoopAdmissionClient";

  public async create(
    config?: NoopAdmissionClientConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<AdmissionClient> {
    const resolved = normalizeConfig(config, factoryArgs);
    return new NoopAdmissionClient(resolved);
  }
}

function normalizeConfig(
  config: NoopAdmissionClientConfig | Record<string, unknown> | null | undefined,
  factoryArgs: unknown[]
): NoopAdmissionClientOptions {
  const fromArgs =
    factoryArgs[0] && typeof factoryArgs[0] === "object"
      ? (factoryArgs[0] as Record<string, unknown>)
      : {};
  const candidate = (config ?? {}) as Record<string, unknown>;

  const systemId =
    typeof candidate.systemId === "string"
      ? candidate.systemId
      : typeof fromArgs.systemId === "string"
        ? fromArgs.systemId
        : undefined;

  const autoAcceptLogicals =
    typeof candidate.autoAcceptLogicals === "boolean"
      ? candidate.autoAcceptLogicals
      : typeof candidate.auto_accept_logicals === "boolean"
        ? candidate.auto_accept_logicals
        : typeof fromArgs.autoAcceptLogicals === "boolean"
          ? fromArgs.autoAcceptLogicals
          : true;

  return {
    autoAcceptLogicals,
    ...(typeof systemId === "string" && systemId.length > 0 ? { systemId } : {}),
  } satisfies NoopAdmissionClientOptions;
}

export default NoopAdmissionClientFactory;
