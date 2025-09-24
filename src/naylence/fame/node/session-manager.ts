export interface SessionManager {
  start(options?: { waitUntilReady?: boolean }): Promise<void>;
  stop(): Promise<void>;
}
