import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  AuthorizationContext,
  DeliveryOriginType,
  NodeAttachAckFrame,
} from 'naylence-core';
import { createFameEnvelope, serializeEnvelope } from 'naylence-core';

import { TransportListener } from './transport-listener.js';
import type { NodeEventListener } from '../node/node-event-listener.js';
import type { NodeLike } from '../node/node-like.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import type { HttpRouter, HttpServer } from './http-server.js';
import type { Authorizer } from '../security/auth/authorizer.js';
import { WebSocketConnector, WebSocketState, type WebSocketConnectorConfig, type WebSocketLike } from './websocket-connector.js';
import { DeliveryOriginType as DeliveryOriginTypeEnum } from 'naylence-core';
import { getLogger } from '../util/logging.js';

const logger = getLogger('websocket-listener');

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

export class WebSocketListener extends TransportListener implements NodeEventListener {
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

    const wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
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
      throw new Error('WebSocketListener requires a RoutingNodeLike node instance');
    }

    this._node = node;
    this._publicUrl = node.publicUrl ?? null;

    logger.debug('registering_websocket_routes', { baseUrl: this._httpServer.actualBaseUrl });

    const router = await this.createRouter();
    await this._httpServer.includeRouter(router, { prefix: this.attachPrefix });
    this._routerRegistered = true;

    logger.debug('websocket_routes_registered', { baseUrl: this._httpServer.actualBaseUrl });
  }

  async onNodeStarted(_node: NodeLike): Promise<void> {
    // Listener leverages shared HTTP server lifecycle
  }

  async onNodeStopped(_node: NodeLike): Promise<void> {
    this._routerRegistered = false;
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
          const socketCandidate = (connection as any)?.socket ?? (connection as WebSocketLike);
          void this._handleWebSocketAttach(socketCandidate, request);
        }
      );
    };

    return plugin;
  }

  private async _handleWebSocketAttach(
    socket: WebSocketLike,
    request: FastifyRequest<{ Params: AttachParams }>
  ): Promise<void> {
    const { downstreamOrPeer, systemId } = request.params;
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
      this._closeSocket(socket, WS_POLICY_VIOLATION, 'Self attachment not allowed');
      return;
    }

    const token = this._extractBearerToken(request.headers['sec-websocket-protocol']);
    if (!token) {
      logger.warning('websocket_attach_without_token');
    }

    try {
      const authorization = await this._authenticateConnection(token, systemId);

      const connector = await this._createWebSocketConnector({
        systemId,
        websocket: socket,
        originType,
        ...(authorization ? { authorization } : {}),
      });

      logger.debug('websocket_connector_registered', { systemId });

      await connector.waitUntilClosed();
    } catch (error) {
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
    const parts = values
      .flatMap((value) => value.split(','))
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    if (parts.length > 0 && parts[0] === 'bearer') {
      return parts[1] ?? '';
    }
    return '';
  }

  private async _authenticateConnection(token: string, systemId: string): Promise<AuthorizationContext | undefined> {
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
        throw new WebSocketAuthenticationError('Authentication failed', WS_POLICY_VIOLATION, 'Authentication failed');
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

    const connectorConfig: WebSocketConnectorConfig = {};
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
      params.authorization ? { ...baseOptions, authorization: params.authorization } : baseOptions
    );

    if (!(connector instanceof WebSocketConnector)) {
      throw new Error(`Invalid connector type returned: ${connector?.constructor?.name ?? 'unknown'}`);
    }

    return connector;
  }

  private async _handleAttachmentError(socket: WebSocketLike, error: unknown, systemId: string): Promise<void> {
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
      logger.error('websocket_attach_error', { systemId, error: error.message });
    } else {
      logger.error('websocket_attach_error', { systemId, error: String(error) });
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
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    } finally {
      this._closeSocket(socket, closeCode, closeReason);
    }
  }

  private _closeSocket(socket: WebSocketLike, code: number, reason: string): void {
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

export function getWebsocketConnector(_systemId: string): WebSocketConnector | null {
  return null;
}

export function getWebsocketListenerInstance(): WebSocketListener | null {
  return _lastWebSocketListenerInstance;
}
