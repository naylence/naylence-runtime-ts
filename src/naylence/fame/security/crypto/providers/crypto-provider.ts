export interface CryptoProvider {
  prepareForAttach?(
    systemId: string,
    assignedPath: string | undefined,
    acceptedLogicals: string[]
  ): void;
  nodeJwk?(): Record<string, unknown> | null | undefined;
  getJwks?(): { keys?: Array<Record<string, unknown>> } | null | undefined;
}

let instance: CryptoProvider | null = null;

export function getCryptoProvider(): CryptoProvider | null {
  return instance;
}

export function setCryptoProvider(provider: CryptoProvider | null): void {
  instance = provider;
}
