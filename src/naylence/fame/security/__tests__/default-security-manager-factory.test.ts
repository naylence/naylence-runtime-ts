import { describe, expect, it, jest } from '@jest/globals';
import {
  createAuthorizationContext,
  type AuthorizationContext,
  type FameEnvelope,
  type DataFrame,
  type SecureAcceptFrame,
  type SecureCloseFrame,
  type SecureOpenFrame,
} from '@naylence/core';

import { DefaultSecurityManagerFactory } from '../default-security-manager-factory.js';
import { SecurityManagerFactory } from '../security-manager-factory.js';
import { DefaultSecurityManager } from '../default-security-manager.js';
import type { SecurityManager } from '../security-manager.js';
import type { KeyManager } from '../keys/key-manager.js';
import type { KeyRecord } from '../keys/key-store.js';
import type { Authorizer } from '../auth/authorizer.js';
import type { NodeEventListener } from '../../node/node-event-listener.js';
import type { EnvelopeSigner } from '../signing/envelope-signer.js';
import type { EnvelopeVerifier } from '../signing/envelope-verifier.js';
import type {
  SecureChannelManager,
  SecureChannelState,
} from '../encryption/secure-channel-manager.js';
import {
  type EncryptionManager,
  EncryptionResult,
} from '../encryption/encryption-manager.js';
import type { CryptoProvider } from '../crypto/providers/crypto-provider.js';
import type { SecurityPolicy } from '../policy/security-policy.js';
import {
  CryptoLevel,
  SecurityAction,
  SecurityRequirements,
} from '../policy/security-policy.js';
import { EncryptionManagerFactory } from '../encryption/encryption-manager-factory.js';

// Ensure default factory registrations are loaded for the test environment.
import '../policy/default-security-policy-factory.js';
import '../keys/default-key-manager-factory.js';
import '../signing/eddsa-envelope-signer-factory.js';
import '../signing/eddsa-envelope-verifier-factory.js';
import '../auth/default-authorizer-factory.js';

class StubKeyManager implements KeyManager {
  public readonly priority = 500;

  public hasKey = jest.fn(async () => true);
  public addKeys = jest.fn(async () => {});
  public announceKeysToUpstream = jest.fn(async () => {});
  public handleKeyRequest = jest.fn(async () => {});
  public removeKeysForPath = jest.fn(async () => 0);
  public getKeysForPath = jest.fn(async (): Promise<Iterable<KeyRecord>> => []);
  public getKey = jest.fn(
    async (): Promise<KeyRecord> => ({ kid: 'stub' }) as KeyRecord
  );

  public onNodeStarted = jest.fn(async () => {});
  public onNodeStopped = jest.fn(async () => {});
  public onNodeInitialized = jest.fn(async () => {});
}

class ListenerAuthorizer implements Authorizer, NodeEventListener {
  public readonly priority = 250;

  public authenticate = jest.fn(async () => this.createContext());
  public authorize = jest.fn(async () => this.createContext());
  public createReverseAuthorizationConfig = jest.fn(async () => ({}));

  private createContext(): AuthorizationContext {
    return createAuthorizationContext({
      authenticated: true,
      authorized: true,
      principal: 'listener',
    });
  }
}

class StubSecurityPolicy implements SecurityPolicy {
  public async shouldSignEnvelope(): Promise<boolean> {
    return false;
  }

  public async shouldEncryptEnvelope(): Promise<boolean> {
    return false;
  }

  public async getEncryptionOptions(): Promise<undefined> {
    return undefined;
  }

  public async shouldVerifySignature(): Promise<boolean> {
    return false;
  }

  public async shouldDecryptEnvelope(): Promise<boolean> {
    return true;
  }

  public classifyMessageCryptoLevel(): CryptoLevel {
    return CryptoLevel.PLAINTEXT;
  }

  public isInboundCryptoLevelAllowed(): boolean {
    return true;
  }

  public getInboundViolationAction(): SecurityAction {
    return SecurityAction.ALLOW;
  }

  public async decideResponseCryptoLevel(): Promise<CryptoLevel> {
    return CryptoLevel.PLAINTEXT;
  }

  public async decideOutboundCryptoLevel(): Promise<CryptoLevel> {
    return CryptoLevel.PLAINTEXT;
  }

  public isSignatureRequired(): boolean {
    return false;
  }

  public getUnsignedViolationAction(): SecurityAction {
    return SecurityAction.ALLOW;
  }

  public getInvalidSignatureViolationAction(): SecurityAction {
    return SecurityAction.ALLOW;
  }

  public requirements(): SecurityRequirements {
    return new SecurityRequirements();
  }

  public validateAttachSecurityCompatibility(_options?: {
    peerKeys?: Array<Record<string, unknown>>;
    peerRequirements?: SecurityRequirements;
    nodeLike?: unknown;
  }): [boolean, string?] {
    return [true];
  }
}

class StubSecureChannelManager implements SecureChannelManager {
  public readonly channels: Readonly<Record<string, SecureChannelState>> = {};

  public generateOpenFrame(
    _channelId: string,
    _algorithm?: string
  ): SecureOpenFrame {
    throw new Error('not implemented');
  }

  public async handleOpenFrame(
    _frame: SecureOpenFrame
  ): Promise<SecureAcceptFrame> {
    throw new Error('not implemented');
  }

  public async handleAcceptFrame(_frame: SecureAcceptFrame): Promise<boolean> {
    return true;
  }

  public handleCloseFrame(_frame: SecureCloseFrame): void {
    /* no-op */
  }

  public isChannelEncrypted(_frame: DataFrame): boolean {
    return false;
  }

  public hasChannel(_channelId: string): boolean {
    return false;
  }

  public getChannelInfo(_channelId: string): Record<string, unknown> | null {
    return null;
  }

  public closeChannel(_channelId: string, _reason?: string): SecureCloseFrame {
    throw new Error('not implemented');
  }

  public cleanupExpiredChannels(): number {
    return 0;
  }

  public addChannel(
    _channelId: string,
    _channelState: SecureChannelState
  ): void {
    /* no-op */
  }

  public removeChannel(_channelId: string): boolean {
    return false;
  }

  public removeChannelsForDestination(_destination: string): number {
    return 0;
  }
}

class StubEnvelopeSigner implements EnvelopeSigner {
  public signEnvelope(envelope: FameEnvelope): FameEnvelope {
    return envelope;
  }
}

class StubEnvelopeVerifier implements EnvelopeVerifier {
  public async verifyEnvelope(): Promise<boolean> {
    return true;
  }
}

class StubEncryptionManager implements EncryptionManager {
  public async encryptEnvelope(
    envelope: FameEnvelope
  ): Promise<EncryptionResult> {
    return EncryptionResult.ok(envelope);
  }

  public async decryptEnvelope(envelope: FameEnvelope): Promise<FameEnvelope> {
    return envelope;
  }
}

describe('DefaultSecurityManagerFactory', () => {
  it('creates a DefaultSecurityManager with default dependencies', async () => {
    const factory = new DefaultSecurityManagerFactory();
    const manager = await factory.create();

    expect(manager).toBeInstanceOf(DefaultSecurityManager);
    expect(manager.policy).toBeDefined();
    // Default build initializes lazily; key manager is provided when required by policy.
    expect(manager.keyManager).toBeNull();
  });

  it('reuses a provided key manager override', async () => {
    const keyManager = new StubKeyManager();
    const manager = await SecurityManagerFactory.createSecurityManager({
      keyManager,
    });

    expect(manager).toBeInstanceOf(DefaultSecurityManager);
    expect((manager as SecurityManager).keyManager).toBe(keyManager);
    expect(keyManager.hasKey).not.toHaveBeenCalled();
  });

  it('adds provided authorizer to event listeners when applicable', async () => {
    const listeners: NodeEventListener[] = [];
    const authorizer = new ListenerAuthorizer();
    const factory = new DefaultSecurityManagerFactory();

    const manager = await factory.create(null, {
      authorizer,
      eventListeners: listeners,
    });

    expect(manager.authorizer).toBe(authorizer);
    expect(listeners).toContain(authorizer);
  });

  it('passes crypto provider when creating encryption manager from config', async () => {
    const factory = new DefaultSecurityManagerFactory();
    const policy = new StubSecurityPolicy();
    const keyManager = new StubKeyManager();
    const secureChannelManager = new StubSecureChannelManager();
    const encryptionManager = new StubEncryptionManager();
    const cryptoProvider: CryptoProvider = {
      encryptionPrivatePem:
        '-----BEGIN PRIVATE KEY-----\nPEM\n-----END PRIVATE KEY-----',
      encryptionPublicPem:
        '-----BEGIN PUBLIC KEY-----\nPEM\n-----END PUBLIC KEY-----',
      encryptionKeyId: 'enc-123',
    };

    const spy = jest
      .spyOn(EncryptionManagerFactory, 'createEncryptionManager')
      .mockResolvedValue(encryptionManager);

    try {
      await factory.create({
        policy,
        key_manager: keyManager,
        secure_channel_manager: secureChannelManager,
        crypto_provider: cryptoProvider,
        envelope_signer: new StubEnvelopeSigner(),
        envelope_verifier: new StubEnvelopeVerifier(),
        encryption_manager: { type: 'NoopEncryptionManager' },
      });

      expect(spy).toHaveBeenCalled();
      const configCall = spy.mock.calls.find((call) => {
        const [config] = call as [Record<string, unknown> | undefined];
        return Boolean(config && config.type === 'NoopEncryptionManager');
      });
      expect(configCall).toBeDefined();
      const dependencies = configCall?.[1]?.dependencies as
        | { cryptoProvider?: CryptoProvider | null }
        | undefined;
      expect(dependencies?.cryptoProvider).toBe(cryptoProvider);
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts snake_case policy instances in configuration', async () => {
    const factory = new DefaultSecurityManagerFactory();
    const policy = new StubSecurityPolicy();
    const keyManager = new StubKeyManager();
    const signer = new StubEnvelopeSigner();
    const verifier = new StubEnvelopeVerifier();
    const encryptionManager = new StubEncryptionManager();
    const secureChannelManager = new StubSecureChannelManager();

    const manager = await factory.create({
      security_policy: policy,
      key_manager: keyManager,
      envelope_signer: signer,
      envelope_verifier: verifier,
      encryption_manager: encryptionManager,
      secure_channel_manager: secureChannelManager,
    });

    expect(manager.policy).toBe(policy);
    expect(manager.keyManager).toBe(keyManager);
    expect(manager.encryption).toBe(encryptionManager);
  });
});
