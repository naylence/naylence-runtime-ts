import { z } from 'zod';
import type { AdmissionConfig } from './admission/admission-client-factory.js';
import type { ConnectionRetryPolicyConfig } from './connection-retry-policy-factory.js';
import type { NodeIdentityPolicyConfig } from './node-identity-policy-factory.js';
import type { NodeLikeConfig } from './node-like-factory.js';
import type { DeliveryPolicyConfig } from '../delivery/delivery-policy-config.js';
import type { TransportListenerConfig } from '../connector/transport-listener-config.js';
import type { SecurityManagerConfig } from '../security/security-manager-config.js';
import type { KeyStoreConfig } from '../security/keys/key-store-factory.js';
import type { AttachmentKeyValidatorConfig } from '../security/keys/attachment-key-validator-factory.js';
import type { StorageProviderConfig } from '../storage/storage-provider-factory.js';
import type { TraceEmitterConfig } from '../telemetry/trace-emitter-config.js';

export type FameNodeMode = 'dev' | 'prod';

const FameNodeModeSchema = z
  .union([z.literal('dev'), z.literal('prod')])
  .default('prod');

const FameNodeConfigSchemaInternal = z
  .object({
    type: z.literal('Node').default('Node'),
    mode: FameNodeModeSchema,
    id: z.string().optional().nullable(),
    directParentUrl: z.string().optional().nullable(),
    admission: z.unknown().optional().nullable(),
    requestedLogicals: z.array(z.string()).default([]),
    delivery: z.unknown().optional().nullable(),
    envContext: z.record(z.string(), z.unknown()).default({}),
    services: z.array(z.unknown()).default([]),
    hasParent: z.boolean().default(false),
    security: z.unknown().optional().nullable(),
    listeners: z.array(z.record(z.string(), z.unknown())).default([]),
    publicUrl: z.string().optional().nullable(),
    keyStore: z.unknown().optional().nullable(),
    storage: z.unknown().optional().nullable(),
    attachmentKeyValidator: z.unknown().optional().nullable(),
    telemetry: z.unknown().optional().nullable(),
    requestedCapabilities: z.array(z.string()).optional(),
    identityPolicy: z.unknown().optional().nullable(),
    connectionRetryPolicy: z.unknown().optional().nullable(),
  })
  .passthrough();

export type FameNodeConfig = NodeLikeConfig & {
  type: 'Node';
  mode: FameNodeMode;
  id?: string | null;
  directParentUrl?: string | null;
  admission?: AdmissionConfig | Record<string, unknown> | null;
  requestedLogicals: string[];
  delivery?: DeliveryPolicyConfig | Record<string, unknown> | null;
  envContext: Record<string, unknown>;
  services: unknown[];
  hasParent: boolean;
  security?: SecurityManagerConfig | Record<string, unknown> | null;
  listeners: TransportListenerConfig[];
  publicUrl?: string | null;
  keyStore?: KeyStoreConfig | Record<string, unknown> | null;
  storage?: StorageProviderConfig | Record<string, unknown> | null;
  attachmentKeyValidator?:
    | AttachmentKeyValidatorConfig
    | Record<string, unknown>
    | null;
  telemetry?: TraceEmitterConfig | Record<string, unknown> | null;
  requestedCapabilities?: string[];
  identityPolicy?: NodeIdentityPolicyConfig | Record<string, unknown> | null;
  connectionRetryPolicy?: ConnectionRetryPolicyConfig | Record<string, unknown> | null;
};

export function normalizeFameNodeConfig(
  input?: Partial<FameNodeConfig> | Record<string, unknown> | null
): FameNodeConfig {
  const parsed = FameNodeConfigSchemaInternal.parse(input ?? {});

  const normalized: FameNodeConfig = {
    type: 'Node',
    mode: (parsed.mode ?? 'prod') as FameNodeMode,
    id: parsed.id ?? null,
    directParentUrl: parsed.directParentUrl ?? null,
    admission:
      parsed.admission === undefined
        ? null
        : (parsed.admission as
            | AdmissionConfig
            | Record<string, unknown>
            | null),
    requestedLogicals: coerceStringArray(parsed.requestedLogicals),
    delivery:
      parsed.delivery === undefined
        ? null
        : (parsed.delivery as
            | DeliveryPolicyConfig
            | Record<string, unknown>
            | null),
    envContext: isPlainRecord(parsed.envContext)
      ? { ...parsed.envContext }
      : {},
    services: Array.isArray(parsed.services) ? [...parsed.services] : [],
    hasParent: Boolean(parsed.hasParent),
    security:
      parsed.security === undefined
        ? null
        : (parsed.security as
            | SecurityManagerConfig
            | Record<string, unknown>
            | null),
    listeners: coerceTransportListeners(parsed.listeners),
    publicUrl: parsed.publicUrl ?? null,
    keyStore:
      parsed.keyStore === undefined
        ? null
        : (parsed.keyStore as KeyStoreConfig | Record<string, unknown> | null),
    storage:
      parsed.storage === undefined
        ? null
        : (parsed.storage as
            | StorageProviderConfig
            | Record<string, unknown>
            | null),
    attachmentKeyValidator:
      parsed.attachmentKeyValidator === undefined
        ? null
        : (parsed.attachmentKeyValidator as
            | AttachmentKeyValidatorConfig
            | Record<string, unknown>
            | null),
    telemetry:
      parsed.telemetry === undefined
        ? null
        : (parsed.telemetry as
            | TraceEmitterConfig
            | Record<string, unknown>
            | null),
    identityPolicy:
      parsed.identityPolicy === undefined
        ? null
        : (parsed.identityPolicy as
            | NodeIdentityPolicyConfig
            | Record<string, unknown>
            | null),
    connectionRetryPolicy:
      parsed.connectionRetryPolicy === undefined
        ? null
        : (parsed.connectionRetryPolicy as
            | ConnectionRetryPolicyConfig
            | Record<string, unknown>
            | null),
  };

  if (parsed.requestedCapabilities) {
    normalized.requestedCapabilities = coerceStringArray(
      parsed.requestedCapabilities
    );
  }

  return normalized;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function coerceTransportListeners(value: unknown): TransportListenerConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is TransportListenerConfig =>
      Boolean(
        item &&
          typeof item === 'object' &&
          typeof (item as { type?: unknown }).type === 'string'
      )
    )
    .map((listener) => ({ ...(listener as TransportListenerConfig) }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
