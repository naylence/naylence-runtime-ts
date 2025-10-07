import { describe, expect, it, jest } from '@jest/globals';
import {
  createAuthorizationContext,
  type AuthorizationContext,
} from 'naylence-core';

import { DefaultSecurityManagerFactory } from '../default-security-manager-factory.js';
import { SecurityManagerFactory } from '../security-manager-factory.js';
import { DefaultSecurityManager } from '../default-security-manager.js';
import type { SecurityManager } from '../security-manager.js';
import type { KeyManager } from '../keys/key-manager.js';
import type { KeyRecord } from '../keys/key-store.js';
import type { Authorizer } from '../auth/authorizer.js';
import type { NodeEventListener } from '../../node/node-event-listener.js';

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
});
