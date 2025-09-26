import { generateId } from 'naylence-core';
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
import { SecurityManagerFactory, SECURITY_MANAGER_FACTORY_BASE_TYPE } from '../security/security-manager-factory.js';
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

const BINDING_STORE_NAMESPACE = '__binding_store';

const logger = getLogger('node-factory');

class BindingStoreEntryRecord implements BindingStoreEntry {
  public readonly address: string;
  public encryptionKeyId: string | null;
  public physicalPath: string | null;

  constructor(address: string, encryptionKeyId: string | null = null, physicalPath: string | null = null) {
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
  eventListeners: NodeEventListener[];
  transportListeners: TransportListener[];
  traceEmitter: TraceEmitter | null;
}

interface SecurityManagerOverrides {
  keyStore: KeyStore;
  keyValidator?: AttachmentKeyValidator | null;
  eventListeners?: NodeEventListener[];
}

export async function makeCommonOptions(config: FameNodeConfig): Promise<CommonNodeComponents> {
  const storageProvider = await resolveStorageProvider(config.storage ?? null);
  const nodeMetaStore = await storageProvider.getKeyValueStore<NodeMetaRecord>(
    NodeMetaRecord,
    NODE_META_NAMESPACE
  );
  const nodeMeta = await nodeMetaStore.get('self');

  const admissionClient = await resolveAdmissionClient(config.admission ?? null);
  const requestedLogicals = [...config.requestedLogicals];
  const hasParent = determineHasParent(config, admissionClient);

  const replicaStickinessManager = await resolveReplicaStickinessManager(hasParent, requestedLogicals);

  const attachmentKeyValidator = await resolveAttachmentKeyValidator(config.attachmentKeyValidator ?? null);
  const keyStore = await resolveKeyStore(config.keyStore ?? null, storageProvider);

  const deliveryPolicy = await resolveDeliveryPolicy(config.delivery ?? null);

  const deliveryTracker = new DefaultDeliveryTracker(storageProvider);

  const transportListeners = await resolveTransportListeners(config.listeners);

  const eventListeners: NodeEventListener[] = [];
  addEventListener(deliveryTracker, eventListeners);

  const traceEmitter = await resolveTraceEmitter(config.telemetry ?? null);
  if (traceEmitter) {
    addEventListener(traceEmitter, eventListeners);
  }

  if (admissionClient) {
    addEventListener(admissionClient, eventListeners);
  }

  if (replicaStickinessManager) {
    addEventListener(replicaStickinessManager, eventListeners);
  }

  const securityManager = await resolveSecurityManager(
    config.security ?? null,
    {
      keyStore,
      keyValidator: attachmentKeyValidator,
      eventListeners,
    }
  );
  addEventListener(securityManager, eventListeners);

  for (const listener of transportListeners) {
    addEventListener(listener, eventListeners);
  }

  const bindingStore = await storageProvider.getKeyValueStore<BindingStoreEntry>(
    BindingStoreEntryRecord,
    BINDING_STORE_NAMESPACE
  );

  const systemId = config.id ?? nodeMeta?.id ?? generateId();

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
    eventListeners,
    transportListeners,
    traceEmitter,
  };
}

async function resolveStorageProvider(
  config: StorageProviderConfig | Record<string, unknown> | null
): Promise<StorageProvider> {
  if (config) {
    try {
      return await StorageProviderFactory.createStorageProvider(config);
    } catch (error) {
      logger.warning('storage_provider_creation_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return new InMemoryStorageProvider();
}

async function resolveAdmissionClient(
  config: Record<string, unknown> | AdmissionClient | null
): Promise<AdmissionClient | null> {
  try {
    return await AdmissionClientFactory.createAdmissionClient(config as Record<string, unknown> | null);
  } catch (error) {
    logger.warning('admission_client_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function determineHasParent(config: FameNodeConfig, admissionClient: AdmissionClient | null): boolean {
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
  requestedLogicals: string[]
): Promise<ReplicaStickinessManager | null> {
  if (!hasParent) {
    return null;
  }

  const hasWildcardLogical = requestedLogicals.some((logical) => typeof logical === 'string' && logical.trim().startsWith('*.'));
  if (!hasWildcardLogical) {
    return null;
  }

  try {
    return await ReplicaStickinessManagerFactory.createReplicaStickinessManager();
  } catch (error) {
    logger.debug('replica_stickiness_manager_unavailable', { error });
    return null;
  }
}

async function resolveAttachmentKeyValidator(
  config: AttachmentKeyValidatorConfig | Record<string, unknown> | null
): Promise<AttachmentKeyValidator | null> {
  try {
    return await AttachmentKeyValidatorFactory.createAttachmentKeyValidator(config ?? undefined);
  } catch (error) {
    logger.warning('attachment_key_validator_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveKeyStore(
  config: KeyStoreConfig | Record<string, unknown> | null,
  storageProvider: StorageProvider
): Promise<KeyStore> {
  return await KeyStoreFactory.createKeyStore(config ?? undefined, { storageProvider });
}

async function resolveDeliveryPolicy(
  config: DeliveryPolicyConfig | Record<string, unknown> | null
): Promise<DeliveryPolicy | null> {
  try {
    return await DeliveryPolicyFactory.createDeliveryPolicy(config ?? undefined);
  } catch (error) {
    logger.warning('delivery_policy_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveTransportListeners(
  configs: TransportListenerConfig[]
): Promise<TransportListener[]> {
  if (!configs.length) {
    return [];
  }

  try {
    return await TransportListenerFactory.createTransportListeners(configs);
  } catch (error) {
    logger.warning('transport_listener_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function resolveTraceEmitter(
  config: TraceEmitterConfig | Record<string, unknown> | null
): Promise<TraceEmitter | null> {
  try {
    return await TraceEmitterFactory.createTraceEmitter(config ?? undefined);
  } catch (error) {
    logger.warning('trace_emitter_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveSecurityManager(
  config: SecurityManagerConfig | Record<string, unknown> | null,
  overrides: SecurityManagerOverrides
): Promise<SecurityManager> {
  if (config) {
    const manager = await createSecurityManagerFromConfig(config, overrides);
    if (manager) {
      return manager;
    }
  }

  return SecurityManagerFactory.createSecurityManager(overrides);
}

async function createSecurityManagerFromConfig(
  config: SecurityManagerConfig | Record<string, unknown>,
  overrides: SecurityManagerOverrides
): Promise<SecurityManager | null> {
  try {
    const options: CreateResourceOptions = {
      factoryArgs: [overrides],
    };
    const manager = await createResource<SecurityManager>(
      SECURITY_MANAGER_FACTORY_BASE_TYPE,
      config,
      options
    );
    return manager ?? null;
  } catch (error) {
    logger.warning('security_manager_creation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function addEventListener(listener: unknown, collection: NodeEventListener[]): void {
  if (!isNodeEventListener(listener)) {
    return;
  }
  if (!collection.includes(listener)) {
    collection.push(listener);
  }
}

function isNodeEventListener(value: unknown): value is NodeEventListener {
  return Boolean(
    value && typeof value === 'object' && typeof (value as NodeEventListener).priority === 'number'
  );
}
