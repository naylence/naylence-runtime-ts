export interface TrustAnchor {
  readonly pem: string;
  readonly kid?: string;
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly spkiSha256?: string;
  readonly version?: number;
}

export interface TrustStoreProvider {
  /**
   * Resolve the PEM-encoded trust bundle used for certificate verification. Implementations
   * should normalize line endings and return the same material they expose via {@link getRoots}.
   */
  getTrustStorePem(): Promise<string>;
  getRoots(): Promise<readonly TrustAnchor[]>;
  onUpdate?(callback: () => void): () => void;
  initialize?(): Promise<void> | void;
}

export type TrustBundleSourceType =
  | "INLINE_PEM"
  | "DATA_PEM"
  | "FILE"
  | "HTTPS_BUNDLE";

export interface TrustBundlePins {
  readonly hashPins?: readonly string[];
  readonly allowedSpkis?: readonly string[];
  readonly allowTofu?: boolean;
  readonly refreshIntervalMs?: number;
}

export interface InlinePemSource {
  readonly type: "INLINE_PEM";
  readonly pem: string;
}

export interface DataPemSource {
  readonly type: "DATA_PEM";
  readonly dataUri: string;
}

export interface FilePemSource {
  readonly type: "FILE";
  readonly path: string;
}

export interface HttpsBundleSource extends TrustBundlePins {
  readonly type: "HTTPS_BUNDLE";
  readonly url: string;
}

export type TrustBundleSource =
  | InlinePemSource
  | DataPemSource
  | FilePemSource
  | HttpsBundleSource;
