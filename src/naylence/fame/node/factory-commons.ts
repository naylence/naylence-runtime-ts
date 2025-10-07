import { generateIdAsync } from 'naylence-core';
import type { CreateResourceOptions } from 'naylence-factory';
import { createResource } from 'naylence-factory';

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

const logger = getLogger('node-factory');

class BindingStoreEntryRecord implements BindingStoreEntry {
  public readonly address: string;
  public encryptionKeyId: string | null;
  public physicalPath: string | null;

  constructor(
    address: string,
    encryptionKeyId: string | null = null,
    physicalPath: string | null = null
  ) {
    this.address = address;
    this.encryptionKeyId = encryptionKeyId;
    this.physicalPath = physicalPath;
  }
}

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

export async function makeCommonOptions(
  config: FameNodeConfig
): Promise<CommonNodeComponents> {
  const expressionOptions = createExpressionOptions(config.envContext);

  const storageProvider = await resolveStorageProvider(
    config.storage ?? null,
    expressionOptions
  );
  const nodeMetaStore = await storageProvider.getKeyValueStore<NodeMetaRecord>(
    NodeMetaRecord,
    NODE_META_NAMESPACE
  );
  const nodeMeta = await nodeMetaStore.get('self');

  const admissionClient = await resolveAdmissionClient(
    config.admission ?? null,
    expressionOptions
  );
  const requestedLogicals = [...config.requestedLogicals];
  const hasParent = determineHasParent(config, admissionClient);

  const replicaStickinessManager = await resolveReplicaStickinessManager(
    hasParent,
    requestedLogicals,
    expressionOptions
  );

  const attachmentKeyValidator = await resolveAttachmentKeyValidator(
    config.attachmentKeyValidator ?? null,
    expressionOptions
  );
  const keyStore = await resolveKeyStore(
    config.keyStore ?? null,
    storageProvider,
    expressionOptions
  );

  const deliveryPolicy = await resolveDeliveryPolicy(
    config.delivery ?? null,
    expressionOptions
  );

  const deliveryTracker = new DefaultDeliveryTracker(storageProvider);

  const transportListeners = await resolveTransportListeners(
    config.listeners,
    expressionOptions
  );

  const eventListeners: NodeEventListener[] = [];
  addEventListener(deliveryTracker, eventListeners);

  const traceEmitter = await resolveTraceEmitter(
    config.telemetry ?? null,
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

  const cryptoProvider = extractCryptoProvider(config.security ?? null);

  const securityManager = await resolveSecurityManager(
    config.security ?? null,
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
    config.id ??
    nodeMeta?.id ??
    (await generateIdAsync({ mode: 'fingerprint' }));

  const attachClientOptions: DefaultNodeAttachClientOptions = {
    ...(attachmentKeyValidator ? { attachmentKeyValidator } : {}),
    ...(replicaStickinessManager ? { replicaStickinessManager } : {}),
  };

  const attachClient = new DefaultNodeAttachClient(attachClientOptions);

  const requestedCapabilities = config.requestedCapabilities
    ? [...config.requestedCapabilities]
    : undefined;

  return {
    systemId,
    hasParent,
    requestedLogicals,
    ...(requestedCapabilities ? { requestedCapabilities } : {}),
    serviceConfigs: [...config.services],
    envContext: { ...config.envContext },
    publicUrl: config.publicUrl ?? null,
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
  config: FameNodeConfig,
  admissionClient: AdmissionClient | null
): boolean {
  if (config.hasParent) {
    return true;
  }
  if (config.directParentUrl) {
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
  options: CreateResourceOptions
): Promise<TransportListener[]> {
  if (!configs.length) {
    return [];
  }

  try {
    return await TransportListenerFactory.createTransportListeners(
      configs,
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
