import { registerFactory } from "naylence-factory";

import {
  DefaultSecurityPolicy,
  type DefaultSecurityPolicyOptions,
} from "./default-security-policy.js";
import {
  EncryptionConfiguration,
  type EncryptionConfig,
  SigningConfiguration,
  type SigningConfig,
  type SecurityPolicy,
  type SecurityPolicyConfig,
} from "./security-policy.js";
import {
  SECURITY_POLICY_FACTORY_BASE_TYPE,
  SecurityPolicyFactory,
} from "./security-policy-factory.js";

export interface DefaultSecurityPolicyConfig extends SecurityPolicyConfig {
  type: "DefaultSecurityPolicy";
  signing?: SigningConfiguration | SigningConfig | null;
  encryption?: EncryptionConfiguration | EncryptionConfig | null;
  [key: string]: unknown;
}

export class DefaultSecurityPolicyFactory extends SecurityPolicyFactory<DefaultSecurityPolicyConfig> {
  public readonly type = "DefaultSecurityPolicy";
  public readonly isDefault = true;

  public async create(
    config?: DefaultSecurityPolicyConfig | Record<string, unknown> | null,
    overrides?: DefaultSecurityPolicyOptions
  ): Promise<SecurityPolicy> {
    const prepared = normalizeConfig(config);
    const options: DefaultSecurityPolicyOptions = { ...overrides };

    if (overrides?.signing === undefined && prepared.signing !== undefined) {
      options.signing = prepared.signing;
    }

    if (overrides?.encryption === undefined && prepared.encryption !== undefined) {
      options.encryption = prepared.encryption;
    }

    return new DefaultSecurityPolicy(options);
  }
}

function normalizeConfig(
  config?: DefaultSecurityPolicyConfig | Record<string, unknown> | null
): DefaultSecurityPolicyConfig {
  if (!config) {
    return { type: "DefaultSecurityPolicy" };
  }

  const candidate = config as Record<string, unknown>;
  const typeValue = typeof candidate.type === "string" ? candidate.type : "DefaultSecurityPolicy";

  if (typeValue !== "DefaultSecurityPolicy") {
    throw new Error(
      `DefaultSecurityPolicyFactory expects type "DefaultSecurityPolicy", got "${String(candidate.type)}"`
    );
  }

  const signing = candidate.signing as SigningConfiguration | SigningConfig | null | undefined;
  const encryption = candidate.encryption as
    | EncryptionConfiguration
    | EncryptionConfig
    | null
    | undefined;

  const result: DefaultSecurityPolicyConfig = { type: "DefaultSecurityPolicy" };

  if (signing !== undefined) {
    result.signing = signing ?? null;
  }

  if (encryption !== undefined) {
    result.encryption = encryption ?? null;
  }

  return result;
}

registerFactory<SecurityPolicy, DefaultSecurityPolicyConfig>(
  SECURITY_POLICY_FACTORY_BASE_TYPE,
  "DefaultSecurityPolicy",
  DefaultSecurityPolicyFactory,
  { isDefault: true }
);
