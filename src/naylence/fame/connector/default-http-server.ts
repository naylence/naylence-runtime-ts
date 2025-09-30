import fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { AddressInfo } from "node:net";

import { getLogger } from "../util/logging.js";
import type { HttpRouter, HttpServer } from "./http-server.js";

const logger = getLogger("default-http-server");

type ServerKey = string;

function makeKey(host: string, port: number): ServerKey {
  return `${host}:${port}`;
}

async function withLock<T>(lock: AsyncLock, fn: () => Promise<T>): Promise<T> {
  return await lock.run(fn);
}

class AsyncLock {
  private _promise: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this._promise;
    this._promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }
}

/**
 * Default Fastify-based HTTP server shared by transport listeners.
 */
export class DefaultHttpServer implements HttpServer {
  private static readonly registry = new Map<ServerKey, DefaultHttpServer>();
  private static readonly referenceCounts = new Map<ServerKey, number>();
  private static readonly lock = new AsyncLock();

  private readonly _host: string;
  private readonly _port: number;
  private readonly _app: FastifyInstance;
  private _started = false;
  private _corePluginsLoaded = false;
  private _actualHost: string | null = null;
  private _actualPort: number | null = null;

  private constructor(host: string, port: number) {
    this._host = host;
    this._port = port;
    this._app = fastify({ logger: false });
  }

  get host(): string {
    return this._host;
  }

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._started;
  }

  get actualHost(): string | null {
    return this._actualHost;
  }

  get actualPort(): number | null {
    return this._actualPort;
  }

  get actualBaseUrl(): string | null {
    if (!this._actualHost || this._actualPort === null) {
      return null;
    }
    const host = this._actualHost === "::" ? "127.0.0.1" : this._actualHost;
    return `http://${host}:${this._actualPort}`;
  }

  async start(): Promise<void> {
    if (this._started) {
      return;
    }

    await this._ensureCorePlugins();

    logger.debug("starting_http_server", { host: this._host, port: this._port });

    const address = await this._app.listen({ host: this._host, port: this._port });

    const nodeServer = this._app.server as { unref?: () => void };
    if (typeof nodeServer?.unref === "function") {
      nodeServer.unref();
    }

    const serverAddress = this._app.server.address();
    if (serverAddress && typeof serverAddress !== "string") {
      const info = serverAddress as AddressInfo;
      this._actualHost = info.address;
      this._actualPort = info.port;
    } else {
      try {
        const url = new URL(typeof address === "string" ? address : String(address));
        this._actualHost = url.hostname;
        this._actualPort = Number(url.port);
      } catch {
        this._actualHost = this._host;
        this._actualPort = this._port;
      }
    }

    this._started = true;
    logger.debug("http_server_started", { baseUrl: this.actualBaseUrl });
  }

  async stop(): Promise<void> {
    if (!this._started) {
      return;
    }

    logger.debug("stopping_http_server", { host: this._host, port: this._port });

    await this._app.close();
    this._started = false;
    this._actualHost = null;
    this._actualPort = null;
  }

  async includeRouter(router: HttpRouter, options?: { prefix?: string }): Promise<void> {
    const wasStarted = this._started;

    await this._ensureCorePlugins();

    if (options) {
      await this._app.register(router as FastifyPluginAsync, options);
    } else {
      await this._app.register(router as FastifyPluginAsync);
    }

    if (!wasStarted) {
      await this.start();
    } else {
      await this._app.ready();
    }
  }

  async includeFastifyPlugin(
    plugin: FastifyPluginAsync,
    options?: Record<string, unknown>
  ): Promise<void> {
    const wasStarted = this._started;

    await this._ensureCorePlugins();

    if (options) {
      await this._app.register(plugin, options);
    } else {
      await this._app.register(plugin);
    }

    if (!wasStarted) {
      await this.start();
    } else {
      await this._app.ready();
    }
  }

  private async _ensureCorePlugins(): Promise<void> {
    if (this._corePluginsLoaded) {
      return;
    }

    await this._app.register(websocketPlugin, {
      options: {
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
      },
    });

    this._corePluginsLoaded = true;
  }

  /**
   * Obtain a shared HTTP server for the given host and port.
   */
  static async getOrCreate(
    params: { host?: string; port?: number } = {}
  ): Promise<DefaultHttpServer> {
    const host = params.host ?? "0.0.0.0";
    const port = params.port ?? 0;
    const key = makeKey(host, port);

    return await withLock(this.lock, async () => {
      let server = this.registry.get(key);
      if (!server) {
        server = new DefaultHttpServer(host, port);
        this.registry.set(key, server);
        this.referenceCounts.set(key, 1);
      } else {
        const current = this.referenceCounts.get(key) ?? 0;
        this.referenceCounts.set(key, current + 1);
      }
      return server;
    });
  }

  /**
   * Release a reference to the shared HTTP server.
   */
  static async release(params: { host?: string; port?: number } = {}): Promise<void> {
    const host = params.host ?? "0.0.0.0";
    const port = params.port ?? 0;
    const key = makeKey(host, port);

    await withLock(this.lock, async () => {
      const count = this.referenceCounts.get(key);
      if (count === undefined) {
        return;
      }

      if (count > 1) {
        this.referenceCounts.set(key, count - 1);
        return;
      }

      const server = this.registry.get(key);
      if (server) {
        await server.stop();
        this.registry.delete(key);
      }
      this.referenceCounts.delete(key);
    });
  }

  /**
   * Stop all active servers and clear the registry.
   */
  static async shutdownAll(): Promise<void> {
    await withLock(this.lock, async () => {
      const servers = Array.from(this.registry.values());
      this.registry.clear();
      this.referenceCounts.clear();
      await Promise.allSettled(servers.map((server) => server.stop()));
    });
  }

  /**
   * Expose the underlying Fastify instance for testing.
   */
  get fastifyInstance(): FastifyInstance {
    return this._app;
  }
}

export type { HttpRouter };
