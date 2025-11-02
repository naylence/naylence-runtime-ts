import type { FameNodeConfig } from '../node-config.js';
import { makeCommonOptions } from '../factory-commons.js';
import { SECURITY_MANAGER_FACTORY_BASE_TYPE } from '../../security/security-manager-factory.js';
import { StorageProviderFactory } from '../../storage/storage-provider-factory.js';
import { AdmissionClientFactory } from '../admission/admission-client-factory.js';
import { ReplicaStickinessManagerFactory } from '../../stickiness/replica-stickiness-manager-factory.js';
import { AttachmentKeyValidatorFactory } from '../../security/keys/attachment-key-validator-factory.js';
import { KeyStoreFactory } from '../../security/keys/key-store-factory.js';
import { DeliveryPolicyFactory } from '../../delivery/delivery-policy-factory.js';
import { TransportListenerFactory } from '../../connector/transport-listener-factory.js';
import { TraceEmitterFactory } from '../../telemetry/trace-emitter-factory.js';
import { SecurityManagerFactory } from '../../security/security-manager-factory.js';
import { DefaultNodeAttachClient } from '../admission/default-node-attach-client.js';
import { DefaultDeliveryTracker } from '../../delivery/default-delivery-tracker.js';
import { createResource } from '@naylence/factory';

jest.mock('../admission/default-node-attach-client.js', () => ({
  DefaultNodeAttachClient: jest.fn(),
}));

jest.mock('../../delivery/default-delivery-tracker.js', () => ({
  DefaultDeliveryTracker: jest.fn(),
}));

const mockStorageProvider = {
  getKeyValueStore: jest.fn(),
};

const defaultNodeAttachClientMock =
  DefaultNodeAttachClient as unknown as jest.Mock;
const defaultDeliveryTrackerMock =
  DefaultDeliveryTracker as unknown as jest.Mock;

jest.mock('../../storage/storage-provider-factory.js', () => ({
  StorageProviderFactory: {
    createStorageProvider: jest.fn(),
  },
}));

jest.mock('../admission/admission-client-factory.js', () => ({
  AdmissionClientFactory: {
    createAdmissionClient: jest.fn(),
  },
}));

jest.mock('../../stickiness/replica-stickiness-manager-factory.js', () => ({
  ReplicaStickinessManagerFactory: {
    createReplicaStickinessManager: jest.fn(),
  },
}));

jest.mock('../../security/keys/attachment-key-validator-factory.js', () => ({
  AttachmentKeyValidatorFactory: {
    createAttachmentKeyValidator: jest.fn(),
  },
}));

jest.mock('../../security/keys/key-store-factory.js', () => ({
  KeyStoreFactory: {
    createKeyStore: jest.fn(),
  },
}));

jest.mock('../../delivery/delivery-policy-factory.js', () => ({
  DeliveryPolicyFactory: {
    createDeliveryPolicy: jest.fn(),
  },
}));

jest.mock('../../connector/transport-listener-factory.js', () => ({
  TransportListenerFactory: {
    createTransportListeners: jest.fn(),
  },
}));

jest.mock('../../telemetry/trace-emitter-factory.js', () => ({
  TraceEmitterFactory: {
    createTraceEmitter: jest.fn(),
  },
}));

jest.mock('../../security/security-manager-factory.js', () => {
  const actual = jest.requireActual(
    '../../security/security-manager-factory.js'
  ) as typeof import('../../security/security-manager-factory.js');

  return {
    ...actual,
    SecurityManagerFactory: {
      ...actual.SecurityManagerFactory,
      createSecurityManager: jest.fn(),
    },
  };
});

jest.mock('@naylence/factory', () => {
  const actual = jest.requireActual('@naylence/factory');
  return {
    ...actual,
    createResource: jest.fn(),
  };
});

describe('makeCommonOptions alias support', () => {
  const mockNodeMetaStore = {
    get: jest.fn(),
  };
  const mockBindingStore = {};
  const mockAdmissionClient = { priority: 2, hasUpstream: true };
  const mockReplicaManager = { priority: 3 };
  const mockAttachmentValidator = { priority: 4 };
  const mockKeyStore = { priority: 5 };
  const mockDeliveryPolicy = { priority: 6 };
  const mockTransportListener = { priority: 7 };
  const mockTraceEmitter = { priority: 8 };
  const mockSecurityManager = { priority: 9 };
  const mockCryptoProvider = { priority: 10 };

  beforeEach(() => {
    jest.clearAllMocks();

    mockNodeMetaStore.get.mockResolvedValue({ id: 'meta-id' });

    (mockStorageProvider.getKeyValueStore as jest.Mock).mockImplementation(
      async (_record: unknown, namespace: string) => {
        if (namespace === '__node_meta') {
          return mockNodeMetaStore;
        }
        if (namespace === '__binding_store') {
          return mockBindingStore;
        }
        throw new Error(`Unexpected namespace: ${namespace}`);
      }
    );

    (
      StorageProviderFactory.createStorageProvider as jest.Mock
    ).mockResolvedValue(mockStorageProvider);

    (
      AdmissionClientFactory.createAdmissionClient as jest.Mock
    ).mockResolvedValue(mockAdmissionClient);

    (
      ReplicaStickinessManagerFactory.createReplicaStickinessManager as jest.Mock
    ).mockResolvedValue(mockReplicaManager);

    (
      AttachmentKeyValidatorFactory.createAttachmentKeyValidator as jest.Mock
    ).mockResolvedValue(mockAttachmentValidator);

    (KeyStoreFactory.createKeyStore as jest.Mock).mockResolvedValue(
      mockKeyStore
    );

    (DeliveryPolicyFactory.createDeliveryPolicy as jest.Mock).mockResolvedValue(
      mockDeliveryPolicy
    );

    (
      TransportListenerFactory.createTransportListeners as jest.Mock
    ).mockResolvedValue([mockTransportListener]);

    (TraceEmitterFactory.createTraceEmitter as jest.Mock).mockResolvedValue(
      mockTraceEmitter
    );

    (
      SecurityManagerFactory.createSecurityManager as jest.Mock
    ).mockResolvedValue(mockSecurityManager);

    (createResource as jest.Mock).mockResolvedValue(mockSecurityManager);

    defaultDeliveryTrackerMock.mockImplementation(() => ({ priority: 1 }));

    defaultNodeAttachClientMock.mockImplementation(() => ({}));
  });

  it('accepts snake_case aliases for node factory configuration', async () => {
    const baseConfig: FameNodeConfig = {
      type: 'Node',
      mode: 'prod',
      id: null,
      directParentUrl: null,
      admission: null,
      requestedLogicals: ['camel'],
      delivery: null,
      envContext: { CAMEL_ONLY: '1' },
      services: [{ name: 'camel-service' }],
      hasParent: false,
      security: null,
      listeners: [],
      publicUrl: null,
      keyStore: null,
      storage: null,
      attachmentKeyValidator: null,
      telemetry: null,
      requestedCapabilities: ['camel-cap'],
    } as FameNodeConfig;

    const config = baseConfig as FameNodeConfig & Record<string, unknown>;
    config.requested_logicals = ['*.snake'];
    config.requested_capabilities = ['snake-cap'];
    config.env_context = { SNAKE_ONLY: 'ok' };
    config.service_configs = [{ name: 'snake-service' }];
    config.transport_listeners = [{ type: 'ws' }];
    config.storage_provider = { type: 'storage-snake' };
    config.admission_client = { type: 'admission-snake' };
    config.attachment_key_validator = { type: 'validator-snake' };
    config.key_store = { type: 'keystore-snake' };
    config.delivery_policy = { type: 'delivery-snake' };
    config.trace_emitter = { type: 'trace-snake' };
    config.security_manager = {
      type: 'security-snake',
      crypto_provider: mockCryptoProvider,
    };
    config.public_url = 'https://snake';
    config.direct_parent_url = 'naylence://parent';
    config.has_parent = true;
    config.system_id = 'snake-system';

    config.services = [];
    config.listeners = [];
    config.storage = null;
    config.admission = null;
    config.attachmentKeyValidator = null;
    config.keyStore = null;
    config.delivery = null;
    config.telemetry = null;
    config.security = null;

    const components = await makeCommonOptions(config);

    expect(StorageProviderFactory.createStorageProvider).toHaveBeenCalledWith(
      config.storage_provider,
      expect.objectContaining({
        env: { CAMEL_ONLY: '1', SNAKE_ONLY: 'ok' },
      })
    );

    expect(AdmissionClientFactory.createAdmissionClient).toHaveBeenCalledWith(
      config.admission_client,
      expect.any(Object)
    );

    expect(
      ReplicaStickinessManagerFactory.createReplicaStickinessManager
    ).toHaveBeenCalled();

    expect(
      AttachmentKeyValidatorFactory.createAttachmentKeyValidator
    ).toHaveBeenCalledWith(config.attachment_key_validator, expect.any(Object));

    expect(KeyStoreFactory.createKeyStore).toHaveBeenCalledWith(
      config.key_store,
      expect.objectContaining({ storageProvider: mockStorageProvider })
    );

    expect(DeliveryPolicyFactory.createDeliveryPolicy).toHaveBeenCalledWith(
      config.delivery_policy,
      expect.any(Object)
    );

    expect(
      TransportListenerFactory.createTransportListeners
    ).toHaveBeenCalledWith(
      config.transport_listeners,
      expect.any(Array),
      expect.any(Object)
    );

    expect(TraceEmitterFactory.createTraceEmitter).toHaveBeenCalledWith(
      config.trace_emitter,
      expect.any(Object)
    );

    expect(createResource).toHaveBeenCalledWith(
      SECURITY_MANAGER_FACTORY_BASE_TYPE,
      config.security_manager,
      expect.objectContaining({
        factoryArgs: expect.arrayContaining([
          expect.objectContaining({ keyStore: mockKeyStore }),
        ]),
      })
    );

    expect(SecurityManagerFactory.createSecurityManager).not.toHaveBeenCalled();

    expect(components.systemId).toBe('snake-system');
    expect(components.publicUrl).toBe('https://snake');
    expect(components.hasParent).toBe(true);
    expect(components.requestedLogicals).toEqual(['camel', '*.snake']);
    expect(components.requestedCapabilities).toEqual([
      'camel-cap',
      'snake-cap',
    ]);
    expect(components.envContext).toEqual({
      SNAKE_ONLY: 'ok',
      CAMEL_ONLY: '1',
    });
    expect(components.serviceConfigs).toEqual([{ name: 'snake-service' }]);
    expect(components.transportListeners).toEqual([mockTransportListener]);
    expect(components.cryptoProvider).toBe(mockCryptoProvider);
    expect(components.eventListeners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priority: 1 }),
        mockAdmissionClient,
        mockReplicaManager,
        mockTraceEmitter,
        mockTransportListener,
        mockSecurityManager,
      ])
    );

    expect(defaultDeliveryTrackerMock).toHaveBeenCalledWith(
      mockStorageProvider
    );

    expect(defaultNodeAttachClientMock).toHaveBeenCalledWith({
      attachmentKeyValidator: mockAttachmentValidator,
      replicaStickinessManager: mockReplicaManager,
    });

    const attachClientInstance =
      defaultNodeAttachClientMock.mock.results[0]?.value;
    expect(components.attachClient).toBe(attachClientInstance);
  });
});
