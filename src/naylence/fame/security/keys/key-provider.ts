export interface KeyProvider {
  getKey(kid: string): Promise<Record<string, unknown>>;
  getKeysForPath(physicalPath: string): Promise<Iterable<Record<string, unknown>>>;
}
