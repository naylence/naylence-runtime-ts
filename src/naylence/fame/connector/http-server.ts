import type { FastifyPluginAsync } from 'fastify';

/**
 * Shared interface for HTTP server instances used by transport listeners.
 */
export interface HttpServer {
  readonly host: string;
  readonly port: number;

  readonly isRunning: boolean;
  readonly actualHost: string | null;
  readonly actualPort: number | null;
  readonly actualBaseUrl: string | null;

  start(): Promise<void>;
  stop(): Promise<void>;

  includeRouter(
    router: FastifyPluginAsync,
    options?: { prefix?: string }
  ): Promise<void>;
}

/**
 * Alias for router plugins registered with the shared HTTP server.
 */
export type HttpRouter = FastifyPluginAsync;
