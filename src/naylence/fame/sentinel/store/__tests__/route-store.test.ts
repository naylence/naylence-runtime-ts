import { InMemoryKeyValueStore } from '../../../storage/in-memory-storage.js';
import type { StorageProvider } from '../../../storage/storage-provider.js';
import type { KeyValueStore } from '../../../storage/key-value-store.js';
import {
  RouteEntryRecord,
  createPersistentRouteStore,
  getDefaultRouteStore,
  normalizeRouteEntry,
  type RouteEntry,
} from '../route-store.js';

class TestStorageProvider implements StorageProvider {
  public readonly underlying = new InMemoryKeyValueStore<RouteEntryRecord>();

  async getKeyValueStore<V>(
    _modelCtor: new (...args: any[]) => V,
    _namespace: string
  ): Promise<KeyValueStore<V>> {
    return this.underlying as unknown as KeyValueStore<V>;
  }
}

describe('route-store alias handling', () => {
  beforeEach(async () => {
    const defaultStore = getDefaultRouteStore();
    const entries = await defaultStore.list();
    await Promise.all(
      Object.keys(entries).map((key) => defaultStore.delete(key))
    );
  });

  it('stores camelCase route entries with synchronized snake_case fields', async () => {
    const provider = new TestStorageProvider();
    const store = createPersistentRouteStore(provider);

    const expiresAt = new Date('2025-01-01T00:00:00Z');
    await store.set('segment', {
      systemId: 'child-camel',
      system_id: 'ignored-value',
      assignedPath: '/camel',
      assigned_path: '/snake',
      instanceId: 'instance-1',
      connectorConfig: { type: 'ws', url: 'wss://example.test' } as any,
      attachExpiresAt: expiresAt,
      metadata: { authenticated: true },
      callbackGrants: [{ scope: 'read' }],
      durable: true,
    });

    const record = await provider.underlying.get('segment');
    expect(record).toBeInstanceOf(RouteEntryRecord);
    expect(record).toMatchObject({
      systemId: 'child-camel',
      system_id: 'child-camel',
      assignedPath: '/camel',
      assigned_path: '/camel',
      instanceId: 'instance-1',
      instance_id: 'instance-1',
      connectorConfig: { type: 'ws', url: 'wss://example.test' },
      connector_config: { type: 'ws', url: 'wss://example.test' },
      attachExpiresAt: expiresAt,
      attach_expires_at: expiresAt,
      callbackGrants: [{ scope: 'read' }],
      callback_grants: [{ scope: 'read' }],
      durable: true,
    });
  });

  it('normalizes snake_case entries when reading from store', () => {
    const expiresAtIso = '2025-06-15T12:00:00Z';
    const normalized = normalizeRouteEntry({
      system_id: 'snake-node',
      assigned_path: '/snake-path',
      instance_id: null,
      connector_config: { type: 'ws', token: 'abc123' } as any,
      attach_expires_at: expiresAtIso,
      metadata: { authorized: true },
      callback_grants: [{ capability: 'svc:call' }],
      durable: true,
    } satisfies RouteEntry);

    expect(normalized).toMatchObject({
      systemId: 'snake-node',
      assignedPath: '/snake-path',
      instanceId: null,
      connectorConfig: { type: 'ws', token: 'abc123' },
      durable: true,
      metadata: { authorized: true },
      callbackGrants: [{ capability: 'svc:call' }],
    });
    expect(normalized.attachExpiresAt?.toISOString()).toBe(
      new Date(expiresAtIso).toISOString()
    );
  });

  it('returns entries with synchronized aliases from the default store', async () => {
    const store = getDefaultRouteStore();
    await store.set('alias-test', {
      systemId: 'alias-node',
      assignedPath: '/alias',
      callbackGrants: [{ scope: 'write' }],
    });

    const entry = await store.get('alias-test');
    expect(entry).toMatchObject({
      systemId: 'alias-node',
      system_id: 'alias-node',
      assignedPath: '/alias',
      assigned_path: '/alias',
      callbackGrants: [{ scope: 'write' }],
      callback_grants: [{ scope: 'write' }],
    });
  });
});
