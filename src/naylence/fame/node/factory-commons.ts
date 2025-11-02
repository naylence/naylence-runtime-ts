import { generateIdAsync } from '@naylence/core';
import type { CreateResourceOptions } from '@naylence/factory';
import { createResource } from '@naylence/factory';

import type { AdmissionClient } from './admission/admission-client.js';
import { AdmissionClientFactory } from './admission/admission-client-factory.js';
import { DefaultNodeAttachClient } from './admission/default-node-attach-client.js';
import type { DefaultNodeAttachClientOptions } from './admission/default-node-attach-client.js';
import type { FameNodeConfig } from './node-config.js';
import type { NodeEventListener } from './node-event-listener.js';
import type { TransportListener } from '../connector/transport-listener.js';
import { TransportListenerFactory } from '../connector/transport-listener-factory.js';
import type { TransportListenerConfig } from '../connector/transport-listener-config.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { StorageProviderFactory } from '../storage/storage-provider-factory.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage.js';
import type { KeyValueStore } from '../storage/key-value-store.js';
import { NodeMetaRecord, NODE_META_NAMESPACE } from './node-meta.js';
import type { BindingStoreEntry } from './binding-manager.js';
import { BindingStoreEntryRecord } from './binding-manager.js';
import type { DeliveryPolicy } from '../delivery/delivery-policy.js';
import { DeliveryPolicyFactory } from '../delivery/delivery-policy-factory.js';
import { DefaultDeliveryTracker } from '../delivery/default-delivery-tracker.js';
import type { KeyStore } from '../security/keys/key-store.js';
import { KeyStoreFactory } from '../security/keys/key-store-factory.js';
import type { AttachmentKeyValidator } from '../security/keys/attachment-key-validator.js';
import { AttachmentKeyValidatorFactory } from '../security/keys/attachment-key-validator-factory.js';
import type { SecurityManager } from '../security/security-manager.js';
import {
  SecurityManagerFactory,
  SECURITY_MANAGER_FACTORY_BASE_TYPE,
} from '../security/security-manager-factory.js';
import type { ReplicaStickinessManager } from '../stickiness/replica-stickiness-manager.js';
import { ReplicaStickinessManagerFactory } from '../stickiness/replica-stickiness-manager-factory.js';
import type { TraceEmitter } from '../telemetry/trace-emitter.js';
import { TraceEmitterFactory } from '../telemetry/trace-emitter-factory.js';
import type { TraceEmitterConfig } from '../telemetry/trace-emitter-config.js';
import type { DeliveryPolicyConfig } from '../delivery/delivery-policy-config.js';
import type { StorageProviderConfig } from '../storage/storage-provider-factory.js';
import type { KeyStoreConfig } from '../security/keys/key-store-factory.js';
import type { AttachmentKeyValidatorConfig } from '../security/keys/attachment-key-validator-factory.js';
import type { SecurityManagerConfig } from '../security/security-manager-config.js';
import { getLogger } from '../util/logging.js';
import type { CryptoProvider } from '../security/crypto/providers/crypto-provider.js';

const BINDING_STORE_NAMESPACE = '__binding_store';

const logger = getLogger('naylence.fame.node.factory_commons');

export interface CommonNodeComponents {
  systemId: string;
  hasParent: boolean;
  requestedLogicals: string[];
  requestedCapabilities?: string[];
  serviceConfigs: unknown[];
  envContext: Record<string, unknown>;
  publicUrl?: string | null;
  storageProvider: StorageProvider;
  nodeMetaStore: KeyValueStore<NodeMetaRecord>;
  bindingStore: KeyValueStore<BindingStoreEntry>;
  keyStore: KeyStore;
  admissionClient: AdmissionClient | null;
  attachClient: DefaultNodeAttachClient;
  attachmentKeyValidator: AttachmentKeyValidator | null;
  replicaStickinessManager: ReplicaStickinessManager | null;
  deliveryPolicy: DeliveryPolicy | null;
  deliveryTracker: DefaultDeliveryTracker;
  securityManager: SecurityManager;
  cryptoProvider: CryptoProvider | null;
  eventListeners: NodeEventListener[];
  transportListeners: TransportListener[];
  traceEmitter: TraceEmitter | null;
}

interface SecurityManagerOverrides {
  keyStore: KeyStore;
  keyValidator?: AttachmentKeyValidator | null;
  eventListeners?: NodeEventListener[];
  cryptoProvider?: CryptoProvider | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function mergeStringArrays(
  primary: string[],
  alias: unknown
): string[] {
  const base = [...primary];
  const seen = new Set(base);
  const aliasValues = coerceStringArray(alias);

  for (const entry of aliasValues) {
    if (!seen.has(entry)) {
      seen.add(entry);
      base.push(entry);
    }
  }

  return base;
}

function mergeOptionalStringArray(
  primary: string[] | undefined,
  alias: unknown
): string[] | undefined {
  const base = primary ? [...primary] : [];
  const seen = new Set(base);
  const aliasValues = coerceStringArray(alias);

  for (const entry of aliasValues) {
    if (!seen.has(entry)) {
      seen.add(entry);
      base.push(entry);
    }
  }

  return base.length ? base : undefined;
}

function mergeEnvContext(
  primary: Record<string, unknown>,
  alias: unknown
): Record<string, unknown> {
  const aliasRecord = isPlainRecord(alias) ? alias : undefined;
  if (!aliasRecord) {
    return { ...primary };
  }

  return { ...aliasRecord, ...primary };
}

function mergeUnknownArray(primary: unknown[], alias: unknown): unknown[] {
  if (primary.length) {
    if (Array.isArray(alias) && alias.length) {
      return [...primary, ...alias];
    }
    return [...primary];
  }

  if (Array.isArray(alias)) {
    return [...alias];
  }

  return [];
}

function coerceTransportListenerConfigs(
  value: unknown
): TransportListenerConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((candidate): candidate is TransportListenerConfig =>
      Boolean(
        candidate &&
          typeof candidate === 'object' &&
          typeof (candidate as { type?: unknown }).type === 'string'
      )
    )
    .map((candidate) => ({ ...(candidate as TransportListenerConfig) }));
}

function pickOption<T>(
  primary: T | null | undefined,
  record: Record<string, unknown>,
  ...aliases: string[]
): T | null | undefined {
  if (primary !== undefined && primary !== null) {
    return primary;
  }

  for (const alias of aliases) {
    if (alias in record) {
      const value = record[alias] as T | null | undefined;
      if (value !== undefined) {
        return value;
      }
    }
  }

  return primary ?? null;
}

function pickString(
  primary: string | null | undefined,
  record: Record<string, unknown>,
  ...aliases: string[]
): string | null {
  const candidate = pickOption<string>(primary, record, ...aliases);
  return typeof candidate === 'string' ? candidate : null;
}

export async function makeCommonOptions(
  config: FameNodeConfig,
  rawConfig?: Record<string, unknown> | null
): Promise<CommonNodeComponents> {
  const configRecord = config as FameNodeConfig & Record<string, unknown>;
  const aliasRecord =
    isPlainRecord(rawConfig) && rawConfig !== configRecord
      ? {
          ...(rawConfig as Record<string, unknown>),
          ...configRecord,
        }
      : configRecord;

  const requestedLogicals = mergeStringArrays(
    config.requestedLogicals,
    aliasRecord.requested_logicals ?? configRecord.requested_logicals
  );

  const requestedCapabilitiesMerged = mergeOptionalStringArray(
    config.requestedCapabilities,
    aliasRecord.requested_capabilities ?? configRecord.requested_capabilities
  );

  const envContext = mergeEnvContext(
    config.envContext,
    aliasRecord.env_context ?? configRecord.env_context
  );

  const services = mergeUnknownArray(
    config.services,
    aliasRecord.service_configs ?? configRecord.service_configs
  );

  const listeners = config.listeners.length
    ? [...config.listeners]
    : coerceTransportListenerConfigs(
        (aliasRecord.transport_listeners ?? configRecord.transport_listeners) ??
          aliasRecord.listener_configs ??
          configRecord.listener_configs
      );

  const storageConfig = pickOption(
    config.storage ?? null,
    aliasRecord,
    'storage_provider',
    'storage_config'
  );

  const admissionConfig = pickOption(
    config.admission ?? null,
    aliasRecord,
    'admission_client'
  );

  const attachmentKeyValidatorConfig = pickOption(
    config.attachmentKeyValidator ?? null,
    aliasRecord,
    'attachment_key_validator'
  );

  const keyStoreConfig = pickOption(
    config.keyStore ?? null,
    aliasRecord,
    'key_store'
  );

  const deliveryConfig = pickOption(
    config.delivery ?? null,
    aliasRecord,
    'delivery_policy'
  );

  const telemetryConfig = pickOption(
    config.telemetry ?? null,
    aliasRecord,
    'trace_emitter',
    'telemetry_config'
  );

  const securityConfig = pickOption(
    config.security ?? null,
    aliasRecord,
    'security_manager',
    'security_profile'
  );

  const publicUrl =
    pickString(config.publicUrl ?? null, aliasRecord, 'public_url') ?? null;

  const directParentUrl =
    pickString(
      config.directParentUrl ?? null,
      aliasRecord,
      'direct_parent_url'
    ) ?? null;

  const hasParentFlag =
    config.hasParent || Boolean(aliasRecord.has_parent ?? false);

  const systemIdOverride = pickString(
    config.id ?? null,
    aliasRecord,
    'system_id',
    'node_id'
  );

  const expressionOptions = createExpressionOptions(envContext);

  const storageProvider = await resolveStorageProvider(
    storageConfig ?? null,
    expressionOptions
  );
  const nodeMetaStore = await storageProvider.getKeyValueStore<NodeMetaRecord>(
    NodeMetaRecord,
    NODE_META_NAMESPACE
  );
  const nodeMeta = await nodeMetaStore.get('self');

  const admissionClient = await resolveAdmissionClient(
    admissionConfig ?? null,
    expressionOptions
  );
  const hasParent = determineHasParent(
    hasParentFlag,
    directParentUrl,
    admissionClient
  );

  const replicaStickinessManager = await resolveReplicaStickinessManager(
    hasParent,
    requestedLogicals,
    expressionOptions
  );

  const attachmentKeyValidator = await resolveAttachmentKeyValidator(
    attachmentKeyValidatorConfig ?? null,
    expressionOptions
  );
  const keyStore = await resolveKeyStore(
    keyStoreConfig ?? null,
    storageProvider,
    expressionOptions
  );

  const deliveryPolicy = await resolveDeliveryPolicy(
    deliveryConfig ?? null,
    expressionOptions
  );

  const eventListeners: NodeEventListener[] = [];

  const deliveryTracker = new DefaultDeliveryTracker(storageProvider);
  addEventListener(deliveryTracker, eventListeners);

  const transportListeners = await resolveTransportListeners(
    listeners,
    eventListeners,
    expressionOptions
  );

  const traceEmitter = await resolveTraceEmitter(
    telemetryConfig ?? null,
    expressionOptions
  );
  if (traceEmitter) {
    addEventListener(traceEmitter, eventListeners);
  }

  if (admissionClient) {
    addEventListener(admissionClient, eventListeners);
  }

  if (replicaStickinessManager) {
    addEventListener(replicaStickinessManager, eventListeners);
  }

  const cryptoProvider = await resolveCryptoProvider(
    securityConfig ?? null,
    expressionOptions
  );

  const securityManager = await resolveSecurityManager(
    securityConfig ?? null,
    {
      keyStore,
      keyValidator: attachmentKeyValidator,
      eventListeners,
      cryptoProvider: cryptoProvider ?? null,
    },
    expressionOptions
  );
  addEventListener(securityManager, eventListeners);

  for (const listener of transportListeners) {
    addEventListener(listener, eventListeners);
  }

  const bindingStore =
    await storageProvider.getKeyValueStore<BindingStoreEntry>(
      BindingStoreEntryRecord,
      BINDING_STORE_NAMESPACE
    );

  const systemId =
    systemIdOverride ??
    nodeMeta?.id ??
    (await generateIdAsync({ mode: 'fingerprint' }));

  const attachClientOptions: DefaultNodeAttachClientOptions = {
    ...(attachmentKeyValidator ? { attachmentKeyValidator } : {}),
    ...(replicaStickinessManager ? { replicaStickinessManager } : {}),
  };

  const attachClient = new DefaultNodeAttachClient(attachClientOptions);

  return {
    systemId,
    hasParent,
    requestedLogicals,
    ...(requestedCapabilitiesMerged && requestedCapabilitiesMerged.length
      ? { requestedCapabilities: requestedCapabilitiesMerged }
      : {}),
    serviceConfigs: [...services],
    envContext: { ...envContext },
    publicUrl,
    storageProvider,
    nodeMetaStore,
    bindingStore,
    keyStore,
    admissionClient,
    attachClient,
    attachmentKeyValidator,
    replicaStickinessManager,
    deliveryPolicy,
    deliveryTracker,
    securityManager,
    cryptoProvider,
    eventListeners,
    transportListeners,
    traceEmitter,
  };
}

async function resolveStorageProvider(
  config: StorageProviderConfig | Record<string, unknown> | null,
  options: CreateResourceOptions
): Promise<StorageProvider> {
  if (config) {
    try {
      return await StorageProviderFactory.createStorageProvider(
        config,
        cloneCreateOptions(options)
      );
    } catch (error) {
      logger.warning('storage_provider_creation_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return new InMemoryStorageProvider();
}

async function resolveAdmissionClient(
  config: Record<string, unknown> | AdmissionClient | null,
  options: CreateResourceOptions
): Promise<AdmissionClient | null> {
  if (config && typeof (config as AdmissionClient).hello === 'function') {
    return config as AdmissionClient;
  }

  try {
    return await AdmissionClientFactory.createAdmissionClient(
      (config ?? null) as Record<string, unknown> | null,
      cloneCreateOptions(options)
    );
  } catch (error) {
    logger.warning('admission_client_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function determineHasParent(
  hasParentFlag: boolean,
  directParentUrl: string | null,
  admissionClient: AdmissionClient | null
): boolean {
  if (hasParentFlag) {
    return true;
  }
  if (directParentUrl) {
    return true;
  }
  return Boolean(admissionClient?.hasUpstream);
}

async function resolveReplicaStickinessManager(
  hasParent: boolean,
  requestedLogicals: string[],
  options: CreateResourceOptions
): Promise<ReplicaStickinessManager | null> {
  if (!hasParent) {
    return null;
  }

  const hasWildcardLogical = requestedLogicals.some(
    (logical) => typeof logical === 'string' && logical.trim().startsWith('*.')
  );
  if (!hasWildcardLogical) {
    return null;
  }

  try {
    return await ReplicaStickinessManagerFactory.createReplicaStickinessManager(
      undefined,
      cloneCreateOptions(options)
    );
  } catch (error) {
    logger.debug('replica_stickiness_manager_unavailable', { error });
    return null;
  }
}

async function resolveAttachmentKeyValidator(
  config: AttachmentKeyValidatorConfig | Record<string, unknown> | null,
  options: CreateResourceOptions
): Promise<AttachmentKeyValidator | null> {
  try {
    return await AttachmentKeyValidatorFactory.createAttachmentKeyValidator(
      config ?? undefined,
      cloneCreateOptions(options)
    );
  } catch (error) {
    logger.warning('attachment_key_validator_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveKeyStore(
  config: KeyStoreConfig | Record<string, unknown> | null,
  storageProvider: StorageProvider,
  options: CreateResourceOptions
): Promise<KeyStore> {
  const baseOptions = cloneCreateOptions(options);
  return await KeyStoreFactory.createKeyStore(config ?? undefined, {
    ...baseOptions,
    storageProvider,
  });
}

async function resolveDeliveryPolicy(
  config: DeliveryPolicyConfig | Record<string, unknown> | null,
  options: CreateResourceOptions
): Promise<DeliveryPolicy | null> {
  try {
    return await DeliveryPolicyFactory.createDeliveryPolicy(
      config ?? undefined,
      cloneCreateOptions(options)
    );
  } catch (error) {
    logger.warning('delivery_policy_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveTransportListeners(
  configs: TransportListenerConfig[],
  eventListeners: NodeEventListener[],
  options: CreateResourceOptions
): Promise<TransportListener[]> {
  if (!configs.length) {
    return [];
  }

  try {
    return await TransportListenerFactory.createTransportListeners(
      configs,
      eventListeners,
      cloneCreateOptions(options)
    );
  } catch (error) {
    logger.warning('transport_listener_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function resolveTraceEmitter(
  config: TraceEmitterConfig | Record<string, unknown> | null,
  options: CreateResourceOptions
): Promise<TraceEmitter | null> {
  try {
    return await TraceEmitterFactory.createTraceEmitter(
      config ?? undefined,
      cloneCreateOptions(options)
    );
  } catch (error) {
    logger.warning('trace_emitter_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveSecurityManager(
  config: SecurityManagerConfig | Record<string, unknown> | null,
  overrides: SecurityManagerOverrides,
  options: CreateResourceOptions
): Promise<SecurityManager> {
  if (config) {
    const manager = await createSecurityManagerFromConfig(
      config,
      overrides,
      options
    );
    if (manager) {
      return manager;
    }
  }

  return SecurityManagerFactory.createSecurityManager(overrides);
}

function createExpressionOptions(
  envContext: Record<string, unknown>
): CreateResourceOptions {
  if (!envContext || typeof envContext !== 'object') {
    return {};
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envContext)) {
    if (value === null || value === undefined) {
      continue;
    }
    env[key] = String(value);
  }

  return Object.keys(env).length > 0 ? { env } : {};
}

function cloneCreateOptions(
  options: CreateResourceOptions
): CreateResourceOptions {
  const clone: CreateResourceOptions = { ...options };

  if (options.env) {
    clone.env = { ...options.env };
  }

  if (options.config) {
    clone.config = { ...options.config };
  }

  if (options.variables) {
    clone.variables = { ...options.variables };
  }

  if (options.factoryArgs) {
    clone.factoryArgs = [...options.factoryArgs];
  }

  return clone;
}

async function createSecurityManagerFromConfig(
  config: SecurityManagerConfig | Record<string, unknown>,
  overrides: SecurityManagerOverrides,
  options: CreateResourceOptions
): Promise<SecurityManager | null> {
  try {
    const mergedOptions = cloneCreateOptions(options);
    const factoryArgs = [...(mergedOptions.factoryArgs ?? [])];
    if (overrides !== undefined) {
      factoryArgs.push(overrides);
    }
    mergedOptions.factoryArgs = factoryArgs;
    const manager = await createResource<SecurityManager>(
      SECURITY_MANAGER_FACTORY_BASE_TYPE,
      config,
      mergedOptions
    );
    return manager ?? null;
  } catch (error) {
    logger.warning('security_manager_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function addEventListener(
  listener: unknown,
  collection: NodeEventListener[]
): void {
  if (!isNodeEventListener(listener)) {
    return;
  }
  if (!collection.includes(listener)) {
    collection.push(listener);
  }
}

function isNodeEventListener(value: unknown): value is NodeEventListener {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as NodeEventListener).priority === 'number'
  );
}

async function resolveCryptoProvider(
  config: SecurityManagerConfig | Record<string, unknown> | null,
  options: CreateResourceOptions
): Promise<CryptoProvider | null> {
  // First, try to extract an explicitly provided crypto provider
  const extracted = extractCryptoProvider(config);
  if (extracted) {
    return extracted;
  }

  // Check if the security configuration requires a crypto provider
  // This happens with overlay security profiles that need envelope signing
  if (requiresCryptoProvider(config)) {
    try {
      logger.debug('auto_creating_crypto_provider', {
        reason: 'overlay_security_requires_signing',
      });

      // Dynamically import to avoid circular dependencies
      const { DefaultCryptoProvider } = await import(
        '../security/crypto/providers/default-crypto-provider.js'
      );

      // Extract environment variables for issuer and audience
      const env = options.env ?? {};
      const issuer =
        typeof env.FAME_JWT_ISSUER === 'string'
          ? env.FAME_JWT_ISSUER
          : 'naylence.runtime.node';
      const audience =
        typeof env.FAME_JWT_AUDIENCE === 'string'
          ? env.FAME_JWT_AUDIENCE
          : 'fame.fabric';

      return await DefaultCryptoProvider.create({
        issuer,
        audience,
        ttlSec: 3600,
      });
    } catch (error) {
      logger.error('failed_to_auto_create_crypto_provider', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return null;
}

function requiresCryptoProvider(
  config: SecurityManagerConfig | Record<string, unknown> | null
): boolean {
  if (!config || typeof config !== 'object') {
    return false;
  }

  const record = config as Record<string, unknown>;

  // Check if using SecurityProfile with overlay variant
  if (
    record.type === 'SecurityProfile' ||
    record.type === 'NodeSecurityProfile'
  ) {
    const profile = record.profile;
    if (typeof profile === 'string') {
      const profileLower = profile.toLowerCase();
      // Overlay variants require crypto provider for envelope signing
      if (
        profileLower.includes('overlay') ||
        profileLower === 'strict-overlay'
      ) {
        return true;
      }
    }
  }

  // Check if DefaultSecurityManager with signing policy
  if (record.type === 'DefaultSecurityManager') {
    const securityPolicy = record.security_policy ?? record.securityPolicy;
    if (securityPolicy && typeof securityPolicy === 'object') {
      const policyRecord = securityPolicy as Record<string, unknown>;
      const signing = policyRecord.signing;
      if (signing && typeof signing === 'object') {
        const signingRecord = signing as Record<string, unknown>;
        const outbound = signingRecord.outbound;
        if (outbound && typeof outbound === 'object') {
          const outboundRecord = outbound as Record<string, unknown>;
          // If default signing is enabled, crypto provider is needed
          if (outboundRecord.defaultSigning === true) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function extractCryptoProvider(
  config: SecurityManagerConfig | Record<string, unknown> | null
): CryptoProvider | null {
  if (!config || typeof config !== 'object') {
    return null;
  }

  const record = config as Record<string, unknown>;

  const tryCandidate = (candidate: unknown): CryptoProvider | null => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return null;
    }

    if (typeof (candidate as { type?: unknown }).type === 'string') {
      return null;
    }

    return candidate as CryptoProvider;
  };

  if ('cryptoProvider' in record) {
    const provider = tryCandidate(record.cryptoProvider);
    if (provider) {
      return provider;
    }
  }

  if ('crypto_provider' in record) {
    const provider = tryCandidate(record.crypto_provider);
    if (provider) {
      return provider;
    }
  }

  return null;
}
