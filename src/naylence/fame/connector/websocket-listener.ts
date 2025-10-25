import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AuthorizationContext,
  DeliveryOriginType,
  NodeAttachAckFrame,
} from '@naylence/core';
import { createFameEnvelope, serializeEnvelope } from '@naylence/core';

import { TransportListener } from './transport-listener.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import type { NodeLike } from '../node/node-like.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import type { HttpRouter, HttpServer } from './http-server.js';
import { DefaultHttpServer } from './default-http-server.js';
import type { Authorizer } from '../security/auth/authorizer.js';
import {
  WebSocketConnector,
  WebSocketState,
  type WebSocketConnectorConfig,
  type WebSocketLike,
} from './websocket-connector.js';
import { DeliveryOriginType as DeliveryOriginTypeEnum } from '@naylence/core';
import { getLogger } from '../util/logging.js';

const logger = getLogger('naylence.fame.connector.websocket_listener');

const WS_POLICY_VIOLATION = 1008;
const WS_INTERNAL_ERROR = 1011;

interface AttachParams {
  downstreamOrPeer: string;
  systemId: string;
}

interface WebSocketListenerOptions {
  authorizer?: Authorizer | undefined;
}

interface AckFramePayload {
  ok: boolean;
  reason?: string | undefined;
  expiresAt?: string | undefined;
}

function isRoutingNodeLike(node: NodeLike): node is RoutingNodeLike {
  return typeof (node as RoutingNodeLike).createOriginConnector === 'function';
}

let _lastWebSocketListenerInstance: WebSocketListener | null = null;

export class WebSocketListener
  extends TransportListener
  implements NodeEventListener
{
  public readonly priority = 1000;

  private readonly _httpServer: HttpServer;
  private readonly _authorizer: Authorizer | undefined;

  private _publicUrl: string | null = null;
  private _routerRegistered = false;
  private _node: RoutingNodeLike | null = null;

  constructor(params: { httpServer: HttpServer } & WebSocketListenerOptions) {
    super();
    this._httpServer = params.httpServer;
    this._authorizer = params.authorizer;
    _lastWebSocketListenerInstance = this;
  }

  get httpServer(): HttpServer {
    return this._httpServer;
  }

  get isRunning(): boolean {
    return this._httpServer.isRunning;
  }

  get baseUrl(): string | null {
    return this._publicUrl ?? this._httpServer.actualBaseUrl;
  }

  get attachPrefix(): string {
    return '/fame/v1/attach';
  }

  get upstreamEndpoint(): string {
    return `${this.attachPrefix}/ws/upstream`;
  }

  get advertisedHost(): string | null {
    return this._httpServer.actualHost;
  }

  get advertisedPort(): number | null {
    return this._httpServer.actualPort;
  }

  getCallbackGrant(): Record<string, unknown> | null {
    return {
      type: 'WebSocketListener',
      base_url: this.baseUrl,
      host: this.advertisedHost,
      port: this.advertisedPort,
    };
  }

  asCallbackGrant(): Record<string, unknown> | null {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      return null;
    }

    const wsUrl = baseUrl
      .replace('http://', 'ws://')
      .replace('https://', 'wss://');
    return {
      type: 'WebSocketStatelessConnector',
      url: `${wsUrl}${this.upstreamEndpoint}`,
    };
  }

  async onNodeInitialized(node: NodeLike): Promise<void> {
    if (this._routerRegistered) {
      return;
    }

    if (!isRoutingNodeLike(node)) {
      throw new Error(
        'WebSocketListener requires a RoutingNodeLike node instance'
      );
    }

    this._node = node;
    this._publicUrl = node.publicUrl ?? null;

    logger.debug('registering_websocket_routes', {
      baseUrl: this._httpServer.actualBaseUrl,
    });

    const router = await this.createRouter();
    await this._httpServer.includeRouter(router, { prefix: this.attachPrefix });
    this._routerRegistered = true;

    logger.debug('websocket_routes_registered', {
      baseUrl: this._httpServer.actualBaseUrl,
    });
  }

  async onNodeStarted(_node: NodeLike): Promise<void> {
    if (this._httpServer.isRunning) {
      return;
    }

    await this._httpServer.start();
  }

  async onNodeStopped(_node: NodeLike): Promise<void> {
    this._routerRegistered = false;
    this._node = null;
    this._publicUrl = null;

    if (this._httpServer instanceof DefaultHttpServer) {
      await DefaultHttpServer.release({
        host: this._httpServer.host,
        port: this._httpServer.port,
      });
    }
  }

  async createRouter(): Promise<HttpRouter> {
    const plugin: FastifyPluginAsync = async (instance) => {
      instance.get('/health', async () => ({
        status: 'healthy',
        active_connections: 0,
        listener_type: 'WebSocketListener',
      }));

      instance.get<{ Params: AttachParams }>(
        '/ws/:downstreamOrPeer/:systemId',
        { websocket: true },
        (connection, request) => {
          const socketCandidate =
            (connection as any)?.socket ?? (connection as WebSocketLike);
          void this._handleWebSocketAttach(socketCandidate, request);
        }
      );
    };

    return plugin;
  }

  private async _handleWebSocketAttach(
    socket: WebSocketLike,
    requestContext: FastifyRequest<{ Params: AttachParams }> | FastifyReply
  ): Promise<void> {
    const request = this._normalizeRequest(requestContext);
    const params = this._resolveAttachParams(request);
    logger.debug('websocket_attach_request', {
      url: request.url,
      rawUrl: typeof request.raw?.url === 'string' ? request.raw.url : null,
      hasParams: Boolean(params),
      requestType: request.constructor?.name,
    });
    if (!params) {
      logger.warning('websocket_attach_missing_params', {
        url:
          typeof request.raw?.url === 'string' ? request.raw.url : request.url,
      });
      this._closeSocket(socket, WS_POLICY_VIOLATION, 'Invalid attach route');
      return;
    }

    const { downstreamOrPeer, systemId } = params;
    const node = this._node;

    if (!node) {
      this._closeSocket(socket, WS_INTERNAL_ERROR, 'Listener not initialized');
      return;
    }

    const originType = this._mapOriginType(downstreamOrPeer);
    if (!originType) {
      logger.warning('websocket_attach_invalid_origin_type', {
        systemId,
        originType: downstreamOrPeer,
      });
      this._closeSocket(socket, WS_POLICY_VIOLATION, 'Invalid origin type');
      return;
    }

    if (!systemId) {
      logger.warning('websocket_attach_no_system_id');
      this._closeSocket(socket, WS_POLICY_VIOLATION, 'Missing system id');
      return;
    }

    if (node.id === systemId) {
      logger.error('websocket_self_attachment_attempt', { systemId });
      this._closeSocket(
        socket,
        WS_POLICY_VIOLATION,
        'Self attachment not allowed'
      );
      return;
    }

    const token =
      this._extractBearerToken(request.headers['sec-websocket-protocol']) ||
      this._extractAuthorizationHeaderToken(request.headers['authorization']);

    if (!token) {
      logger.warning('websocket_attach_without_token');
    }

    // Buffer messages that arrive during authentication to prevent message loss
    // This matches the Python implementation where FastAPI's websocket.accept()
    // buffers messages automatically
    const messageBuffer: Uint8Array[] = [];
    let bufferActive = true;

    const bufferHandler = (event: any) => {
      if (!bufferActive) return;

      try {
        // Normalize the incoming data to Uint8Array
        let data: Uint8Array;
        const rawData = event?.data ?? event;

        if (rawData instanceof Uint8Array) {
          data = rawData;
        } else if (
          typeof Buffer !== 'undefined' &&
          Buffer.isBuffer?.(rawData)
        ) {
          data = new Uint8Array(rawData);
        } else if (rawData instanceof ArrayBuffer) {
          data = new Uint8Array(rawData);
        } else if (typeof rawData === 'string') {
          data = new TextEncoder().encode(rawData);
        } else {
          logger.warning('websocket_buffer_unknown_data_type', {
            systemId,
            dataType: typeof rawData,
          });
          return;
        }

        messageBuffer.push(data);
        logger.debug('websocket_message_buffered', {
          systemId,
          bufferSize: messageBuffer.length,
        });
      } catch (error) {
        logger.error('websocket_buffer_error', {
          systemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Attach buffer handler immediately to capture messages during authentication
    const socketAny = socket as any;
    if (typeof socketAny.addEventListener === 'function') {
      socketAny.addEventListener('message', bufferHandler);
    } else if (typeof socketAny.on === 'function') {
      socketAny.on('message', bufferHandler);
    }

    logger.debug('websocket_buffer_attached', { systemId });

    try {
      const authorization = await this._authenticateConnection(token, systemId);

      // Deactivate buffer before creating connector
      bufferActive = false;

      // Remove buffer handler
      if (typeof socketAny.removeEventListener === 'function') {
        socketAny.removeEventListener('message', bufferHandler);
      } else if (typeof socketAny.off === 'function') {
        socketAny.off('message', bufferHandler);
      } else if (typeof socketAny.removeListener === 'function') {
        socketAny.removeListener('message', bufferHandler);
      }

      logger.debug('websocket_buffer_detached', {
        systemId,
        bufferedMessages: messageBuffer.length,
      });

      const connector = await this._createWebSocketConnector({
        systemId,
        websocket: socket,
        originType,
        ...(authorization ? { authorization } : {}),
      });

      // Push buffered messages to the connector for processing
      if (messageBuffer.length > 0) {
        logger.debug('websocket_replaying_buffered_messages', {
          systemId,
          count: messageBuffer.length,
        });

        for (const data of messageBuffer) {
          try {
            await connector.pushToReceive(data);
          } catch (error) {
            logger.error('websocket_buffer_replay_error', {
              systemId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      logger.debug('websocket_connector_registered', { systemId });

      await connector.waitUntilClosed();
    } catch (error) {
      // Ensure buffer is deactivated and handler removed on error
      bufferActive = false;
      if (typeof socketAny.removeEventListener === 'function') {
        socketAny.removeEventListener('message', bufferHandler);
      } else if (typeof socketAny.off === 'function') {
        socketAny.off('message', bufferHandler);
      } else if (typeof socketAny.removeListener === 'function') {
        socketAny.removeListener('message', bufferHandler);
      }

      await this._handleAttachmentError(socket, error, systemId);
    } finally {
      logger.debug('websocket_connector_unregistered', { systemId });
    }
  }

  private _mapOriginType(candidate: string): DeliveryOriginType | null {
    const normalized = candidate.toLowerCase();
    if (normalized === 'downstream') {
      return DeliveryOriginTypeEnum.DOWNSTREAM;
    }
    if (normalized === 'peer') {
      return DeliveryOriginTypeEnum.PEER;
    }
    return null;
  }

  private _extractBearerToken(header: string | string[] | undefined): string {
    if (!header) {
      return '';
    }

    const values = Array.isArray(header) ? header : [header];

    for (const value of values) {
      const segments = value
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (!segment) {
          continue;
        }

        if (segment.toLowerCase().startsWith('bearer')) {
          const remainder = segment.slice('bearer'.length).trimStart();
          if (remainder.length > 0) {
            return remainder;
          }

          const nextSegment = segments[index + 1];
          if (nextSegment) {
            return nextSegment;
          }

          continue;
        }
      }
    }

    return '';
  }

  private _extractAuthorizationHeaderToken(
    header: string | string[] | undefined
  ): string {
    if (!header) {
      return '';
    }

    const values = Array.isArray(header) ? header : [header];

    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) {
        continue;
      }

      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const lower = trimmed.toLowerCase();
      if (lower.startsWith('bearer')) {
        const remainder = trimmed.slice('bearer'.length).trimStart();
        if (remainder.length > 0) {
          return remainder;
        }

        continue;
      }
    }

    return '';
  }

  private _resolveAttachParams(
    request: FastifyRequest<{ Params: AttachParams }>
  ): AttachParams | null {
    const paramsCandidate = (request as { params?: unknown }).params;
    if (paramsCandidate && typeof paramsCandidate === 'object') {
      const downstreamOrPeer = (paramsCandidate as Record<string, unknown>)
        .downstreamOrPeer;
      const systemId = (paramsCandidate as Record<string, unknown>).systemId;
      if (
        typeof downstreamOrPeer === 'string' &&
        typeof systemId === 'string'
      ) {
        return { downstreamOrPeer, systemId };
      }
    }

    const rawUrl =
      typeof request.raw?.url === 'string' && request.raw.url.length > 0
        ? request.raw.url
        : request.url;
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
      return null;
    }

    const [path] = rawUrl.split('?', 1);
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const wsIndex = segments.lastIndexOf('ws');
    if (wsIndex === -1 || wsIndex + 2 >= segments.length) {
      return null;
    }

    const downstreamOrPeer = decodeURIComponent(segments[wsIndex + 1] ?? '');
    const systemId = decodeURIComponent(segments[wsIndex + 2] ?? '');

    if (!downstreamOrPeer || !systemId) {
      return null;
    }

    return { downstreamOrPeer, systemId };
  }

  private async _authenticateConnection(
    token: string,
    systemId: string
  ): Promise<AuthorizationContext | undefined> {
    const authorizer = await this._resolveAuthorizer();
    if (!authorizer) {
      logger.debug('websocket_attach_no_authorization', { systemId });
      return undefined;
    }

    try {
      const authHeader = token ? `Bearer ${token}` : '';
      const result = await authorizer.authenticate(authHeader);
      if (!result) {
        logger.warning('websocket_attach_authentication_failed', { systemId });
        throw new WebSocketAuthenticationError(
          'Authentication failed',
          WS_POLICY_VIOLATION,
          'Authentication failed'
        );
      }
      logger.debug('websocket_attach_authorization_success', { systemId });
      return result;
    } catch (error) {
      if (error instanceof WebSocketAuthenticationError) {
        throw error;
      }
      logger.error('websocket_attach_authorization_error', {
        systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new WebSocketAuthenticationError(
        `Authorization error: ${error instanceof Error ? error.message : String(error)}`,
        WS_POLICY_VIOLATION,
        'Authorization error'
      );
    }
  }

  private async _resolveAuthorizer(): Promise<Authorizer | undefined> {
    if (this._authorizer) {
      return this._authorizer;
    }

    const node = this._node;
    const securityManager = node?.securityManager;
    if (securityManager?.authorizer) {
      return securityManager.authorizer;
    }
    return undefined;
  }

  private async _createWebSocketConnector(params: {
    systemId: string;
    websocket: WebSocketLike;
    originType: DeliveryOriginType;
    authorization?: AuthorizationContext | undefined;
  }): Promise<WebSocketConnector> {
    const node = this._node;
    if (!node) {
      throw new Error('Node not initialized');
    }

    const connectorConfig: WebSocketConnectorConfig = { type: 'websocket' };
    if (params.authorization) {
      connectorConfig.authorizationContext = params.authorization;
    }

    const baseOptions = {
      originType: params.originType,
      systemId: params.systemId,
      connectorConfig,
      websocket: params.websocket,
    };

    const connector = await node.createOriginConnector(
      params.authorization
        ? { ...baseOptions, authorization: params.authorization }
        : baseOptions
    );

    logger.debug('websocket_connector_created', {
      systemId: params.systemId,
      connectorType: connector.constructor?.name,
    });

    if (!(connector instanceof WebSocketConnector)) {
      throw new Error(
        `Invalid connector type returned: ${connector?.constructor?.name ?? 'unknown'}`
      );
    }

    return connector;
  }

  private _normalizeRequest(
    context: FastifyRequest<{ Params: AttachParams }> | FastifyReply
  ): FastifyRequest<{ Params: AttachParams }> {
    if (
      context &&
      typeof (context as FastifyReply).request === 'object' &&
      (context as FastifyReply).request !== null
    ) {
      return (context as FastifyReply).request as FastifyRequest<{
        Params: AttachParams;
      }>;
    }
    return context as FastifyRequest<{ Params: AttachParams }>;
  }

  private async _handleAttachmentError(
    socket: WebSocketLike,
    error: unknown,
    systemId: string
  ): Promise<void> {
    if (error instanceof WebSocketAuthenticationError) {
      await this._sendAckAndClose(
        socket,
        {
          ok: false,
          reason: error.userReason,
        },
        error.closeCode,
        error.closeReason
      );
      return;
    }

    if (error instanceof Error) {
      logger.error('websocket_attach_error', {
        systemId,
        error: error.message,
      });
    } else {
      logger.error('websocket_attach_error', {
        systemId,
        error: String(error),
      });
    }

    await this._sendAckAndClose(
      socket,
      {
        ok: false,
        reason: `Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
      },
      WS_INTERNAL_ERROR,
      'Internal error'
    );
  }

  private async _sendAckAndClose(
    socket: WebSocketLike,
    frame: AckFramePayload,
    closeCode: number,
    closeReason: string
  ): Promise<void> {
    try {
      if (socket.readyState === WebSocketState.OPEN) {
        const ackFrame: NodeAttachAckFrame = {
          type: 'NodeAttachAck',
          ok: frame.ok,
          ...(frame.reason ? { reason: frame.reason } : {}),
          ...(frame.expiresAt ? { expiresAt: frame.expiresAt } : {}),
        };
        const ackEnvelope = createFameEnvelope({ frame: ackFrame });
        const payload = JSON.stringify(serializeEnvelope(ackEnvelope));
        socket.send(payload);
      }
    } catch (sendError) {
      logger.debug('websocket_ack_send_failed', {
        error:
          sendError instanceof Error ? sendError.message : String(sendError),
      });
    } finally {
      this._closeSocket(socket, closeCode, closeReason);
    }
  }

  private _closeSocket(
    socket: WebSocketLike,
    code: number,
    reason: string
  ): void {
    try {
      (socket as any).close(code, reason);
    } catch (error) {
      logger.debug('websocket_close_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

class WebSocketAuthenticationError extends Error {
  constructor(
    public readonly userReason: string,
    public readonly closeCode: number,
    public readonly closeReason: string
  ) {
    super(userReason);
    this.name = 'WebSocketAuthenticationError';
  }
}

export function getWebsocketConnector(
  _systemId: string
): WebSocketConnector | null {
  return null;
}

export function getWebsocketListenerInstance(): WebSocketListener | null {
  return _lastWebSocketListenerInstance;
}
