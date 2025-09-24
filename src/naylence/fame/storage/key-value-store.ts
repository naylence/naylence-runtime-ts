export interface KeyValueStore<V> {
  set(key: string, value: V): Promise<void>;
  update(key: string, value: V): Promise<void>;
  get(key: string): Promise<V | undefined>;
  delete(key: string): Promise<void>;
  list(): Promise<Record<string, V>>;
}
