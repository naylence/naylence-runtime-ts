export interface DevKeyPair {
  privatePem: string;
  publicPem: string;
  jwks: { keys: Array<Record<string, unknown>> | undefined };
}
