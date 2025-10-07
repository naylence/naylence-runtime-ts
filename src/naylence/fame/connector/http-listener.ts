import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  DeliveryOriginType,
  FameChannelMessage,
  FameResponseType,
  deserializeEnvelope,
  type AuthorizationContext,
  type FameConnector,
  type FameDeliveryContext,
  type FameEnvelope,
  type NodeAttachFrame,
  type SecurityContext,
} from 'naylence-core';

import { TransportListener } from './transport-listener.js';
import type { HttpRouter, HttpServer } from './http-server.js';
import { DefaultHttpServer } from './default-http-server.js';
import type { Authorizer } from '../security/auth/authorizer.js';
import type { NodeLike } from '../node/node-like.js';
import type { RoutingNodeLike } from '../node/routing-node-like.js';
import {
  GrantSelectionContext,
  defaultGrantSelectionPolicy,
} from './grant-selection-policy.js';
import {
  HTTP_CONNECTION_GRANT_TYPE,
  httpGrantToConnectorConfig,
  type HttpConnectionGrantLike,
} from '../grants/http-connection-grant.js';
import {
  WEBSOCKET_CONNECTION_GRANT_TYPE,
  websocketGrantToConnectorConfig,
  type WebSocketConnectionGrantLike,
} from '../grants/websocket-connection-grant.js';
import type { ConnectionGrant } from '../grants/connection-grant.js';
import type { ConnectorConfig } from './connector-config.js';
import { getLogger } from '../util/logging.js';
import type { NoAuthInjectionStrategyConfig } from '../security/auth/no-auth-injection-strategy-factory.js';
import type { RouteManager } from '../sentinel/route-manager.js';

const logger = getLogger('http-listener');

function isRoutingNodeLike(node: NodeLike): node is RoutingNodeLike {
  return typeof (node as RoutingNodeLike).createOriginConnector === 'function';
}

let _lastHttpListenerInstance: HttpListener | null = null;

export class HttpListener extends TransportListener {
  public readonly priority = 1000;

  private readonly _httpServer: HttpServer;
  private readonly _authorizer: Authorizer | undefined;

  private _publicUrl: string | null = null;
  private _routerRegistered = false;
  private _node: RoutingNodeLike | null = null;
  private _reverseAuthConfig:
    | (NoAuthInjectionStrategyConfig | Record<string, unknown>)
    | null = {
    type: 'NoAuth',
  };

  constructor(params: { httpServer: HttpServer; authorizer?: Authorizer }) {
    super();
    this._httpServer = params.httpServer;
    this._authorizer = params.authorizer;
    _lastHttpListenerInstance = this;
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

  get ingressPrefix(): string {
    return '/fame/v1/ingress';
  }

  get upstreamEndpoint(): string {
    return `${this.ingressPrefix}/upstream`;
  }

  asCallbackGrant(): Record<string, unknown> | null {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      return null;
    }

    const grant: Record<string, unknown> = {
      type: HTTP_CONNECTION_GRANT_TYPE,
      url: `${baseUrl}${this.upstreamEndpoint}`,
    };

    const defaultAuth: NoAuthInjectionStrategyConfig = { type: 'NoAuth' };
    grant.auth = this._reverseAuthConfig ?? defaultAuth;

    return grant;
  }

  async onNodeInitialized(node: NodeLike): Promise<void> {
    if (this._routerRegistered) {
      return;
    }

    if (!isRoutingNodeLike(node)) {
      throw new Error('HttpListener requires a RoutingNodeLike node instance');
    }

    this._node = node;
    this._publicUrl = node.publicUrl ?? null;

    logger.debug('registering_http_routes', {
      baseUrl: this._httpServer.actualBaseUrl,
    });

    await this._refreshReverseAuthConfig(node);

    const router = await this.createRouter();
    await this._httpServer.includeRouter(router, {
      prefix: this.ingressPrefix,
    });
    this._routerRegistered = true;

    logger.debug('http_routes_registered', {
      baseUrl: this._httpServer.actualBaseUrl,
    });
  }

  async onNodeStarted(_node: NodeLike): Promise<void> {
    await this._httpServer.start();
  }

  async onNodeStopped(_node: NodeLike): Promise<void> {
    this._routerRegistered = false;

    if (this._httpServer instanceof DefaultHttpServer) {
      await DefaultHttpServer.release({
        host: this._httpServer.host,
        port: this._httpServer.port,
      });
    }
  }

  async createRouter(): Promise<HttpRouter> {
    const plugin: FastifyPluginAsync = async (instance) => {
      instance.post<{ Body: unknown }>('/upstream', async (request, reply) => {
        return await this._handleUpstreamIngress(request, reply);
      });

      instance.post<{ Params: { childId: string }; Body: unknown }>(
        '/downstream/:childId',
        async (request, reply) => {
          return await this._handleDownstreamIngress(request, reply);
        }
      );

      instance.get('/health', async () => ({
        status: 'healthy',
        listener_type: 'HttpListener',
      }));
    };

    return plugin;
  }

  private async _handleUpstreamIngress(
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply
  ): Promise<any> {
    const node = this._node;
    if (!node) {
      return reply.code(503).send({ error: 'Node not initialized' });
    }

    try {
      const authorization = await this._authenticateRequest(
        request.headers['authorization']
      );

      const envelope = this._parseEnvelope(request.body);
      if (!envelope) {
        return reply
          .code(400)
          .send({ error: 'Invalid request body - expected FameEnvelope JSON' });
      }

      const upstreamConnector = node.upstreamConnector;
      if (!upstreamConnector) {
        return reply
          .code(503)
          .send({ error: 'No upstream connector available' });
      }

      const security = authorization
        ? ({ authorization } as SecurityContext)
        : undefined;
      await upstreamConnector.pushToReceive(
        this._buildChannelMessage({
          envelope,
          originType: DeliveryOriginType.UPSTREAM,
          fromConnector: upstreamConnector,
          ...(security ? { security } : {}),
        })
      );

      return reply.code(202).send({ status: 'message_received' });
    } catch (error) {
      return this._handleIngressError(error, reply, 'upstream');
    }
  }

  private async _handleDownstreamIngress(
    request: FastifyRequest<{ Params: { childId: string }; Body: unknown }>,
    reply: FastifyReply
  ): Promise<any> {
    const node = this._node;
    if (!node) {
      return reply.code(503).send({ error: 'Node not initialized' });
    }

    const childId = request.params.childId;

    try {
      const authorization = await this._authenticateRequest(
        request.headers['authorization']
      );
      const envelope = this._parseEnvelope(request.body);
      if (!envelope) {
        return reply
          .code(400)
          .send({ error: 'Invalid request body - expected FameEnvelope JSON' });
      }

      if (this._isNodeAttachFrame(envelope.frame)) {
        if (childId !== envelope.frame.systemId) {
          logger.warning('child_id_mismatch', {
            received: childId,
            frameSystemId: envelope.frame.systemId,
          });
          return reply.code(400).send({ error: 'Child ID mismatch' });
        }

        const connector = await this._handleNodeAttachFrame({
          childId,
          attachFrame: envelope.frame,
          envelope,
          ...(authorization ? { authorization } : {}),
        });

        const security = authorization
          ? ({ authorization } as SecurityContext)
          : undefined;
        await connector.pushToReceive(
          this._buildChannelMessage({
            envelope,
            originType: DeliveryOriginType.DOWNSTREAM,
            fromConnector: connector,
            fromSystemId: childId,
            ...(security ? { security } : {}),
          })
        );

        return reply.code(202).send({ status: 'attach_in_progress' });
      }

      const connector = this._getExistingConnector(childId);
      if (!connector) {
        logger.warning('no_connector_for_child', { childId });
        return reply
          .code(400)
          .send({ error: 'No established connection - NodeAttach required' });
      }

      const security = authorization
        ? ({ authorization } as SecurityContext)
        : undefined;
      await connector.pushToReceive(
        this._buildChannelMessage({
          envelope,
          originType: DeliveryOriginType.DOWNSTREAM,
          fromConnector: connector,
          fromSystemId: childId,
          ...(security ? { security } : {}),
        })
      );

      return reply.code(202).send({ status: 'message_received' });
    } catch (error) {
      return this._handleIngressError(error, reply, 'downstream', childId);
    }
  }

  private _buildChannelMessage(params: {
    envelope: FameEnvelope;
    originType: DeliveryOriginType;
    fromConnector: FameConnector;
    fromSystemId?: string;
    security?: SecurityContext;
  }): FameChannelMessage {
    const context: FameDeliveryContext = {
      originType: params.originType,
      fromConnector: params.fromConnector,
      fromSystemId: params.fromSystemId,
      expectedResponseType: FameResponseType.NONE,
      ...(params.security ? { security: params.security } : {}),
    };

    return new FameChannelMessage(params.envelope, context);
  }

  private async _handleNodeAttachFrame(params: {
    childId: string;
    attachFrame: NodeAttachFrame;
    envelope: FameEnvelope;
    authorization?: AuthorizationContext;
  }): Promise<FameConnector> {
    const node = this._node;
    if (!node) {
      throw new Error('Node not initialized');
    }

    const selectionContext = new GrantSelectionContext({
      childId: params.childId,
      attachFrame: params.attachFrame,
      callbackGrantType: HTTP_CONNECTION_GRANT_TYPE,
      node,
    });

    const selection =
      defaultGrantSelectionPolicy.selectCallbackGrant(selectionContext);
    const connectorConfig = this._grantToConnectorConfig(selection.grant);

    const options = {
      originType: DeliveryOriginType.DOWNSTREAM,
      systemId: params.childId,
      connectorConfig,
      ...(params.authorization ? { authorization: params.authorization } : {}),
    };

    const connector = await node.createOriginConnector(options);

    logger.debug('created_http_connector', {
      child: params.childId,
      connectorType: connector.constructor?.name ?? 'unknown',
      selectionReason: selection.selectionReason,
    });

    return connector;
  }

  private _grantToConnectorConfig(grant: ConnectionGrant): ConnectorConfig {
    switch (grant.type) {
      case HTTP_CONNECTION_GRANT_TYPE:
        return httpGrantToConnectorConfig(grant as HttpConnectionGrantLike);
      case WEBSOCKET_CONNECTION_GRANT_TYPE:
        return websocketGrantToConnectorConfig(
          grant as WebSocketConnectionGrantLike
        );
      default:
        if (typeof grant.toConnectorConfig === 'function') {
          return grant.toConnectorConfig();
        }
    }

    throw new Error(`Unsupported grant type: ${grant.type}`);
  }

  private _getExistingConnector(childId: string): FameConnector | null {
    const node = this._node;
    if (!node) {
      return null;
    }

    const routeManager = (
      node as unknown as { routeManager?: RouteManager | undefined }
    ).routeManager;
    if (!routeManager) {
      return null;
    }

    const existing = routeManager.downstreamRoutes.get(childId) ?? null;
    if (existing) {
      return existing;
    }

    const pending = routeManager._pending_routes.get(childId);
    return pending?.connector ?? null;
  }

  private _isNodeAttachFrame(
    frame: FameEnvelope['frame']
  ): frame is NodeAttachFrame {
    return Boolean(
      frame &&
        typeof frame === 'object' &&
        (frame as { type?: string }).type === 'NodeAttach'
    );
  }

  private _parseEnvelope(body: unknown): FameEnvelope | null {
    if (!body) {
      return null;
    }

    try {
      if (Buffer.isBuffer(body)) {
        const decoded = body.toString('utf8');
        const parsed = JSON.parse(decoded);
        return deserializeEnvelope(parsed);
      }

      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        return deserializeEnvelope(parsed);
      }

      if (typeof body === 'object') {
        return deserializeEnvelope(body as Record<string, unknown>);
      }
    } catch (error) {
      logger.warning('http_listener_envelope_parse_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  private async _authenticateRequest(
    header: unknown
  ): Promise<AuthorizationContext | undefined> {
    const authorizer = await this._resolveAuthorizer();
    if (!authorizer) {
      logger.debug('http_ingress_no_authorization');
      return undefined;
    }

    const token =
      typeof header === 'string'
        ? header
        : Array.isArray(header)
          ? header[0]
          : '';

    try {
      const result = await authorizer.authenticate(token ?? '');
      if (!result) {
        throw new Error('Authentication failed');
      }
      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  private async _resolveAuthorizer(): Promise<Authorizer | undefined> {
    if (this._authorizer) {
      return this._authorizer;
    }

    const node = this._node;
    const securityManager = node?.securityManager ?? null;
    return securityManager?.authorizer ?? undefined;
  }

  private _handleIngressError(
    error: unknown,
    reply: FastifyReply,
    direction: 'upstream' | 'downstream',
    childId?: string
  ) {
    if (error instanceof Error) {
      const status = error.message.includes('Authentication failed')
        ? 401
        : 500;
      logger.error(`http_${direction}_ingress_error`, {
        childId,
        error: error.message,
      });
      return reply.code(status).send({ error: error.message });
    }

    logger.error(`http_${direction}_ingress_error`, {
      childId,
      error: String(error),
    });
    return reply.code(500).send({ error: 'Internal server error' });
  }

  private async _refreshReverseAuthConfig(
    node: RoutingNodeLike
  ): Promise<void> {
    const defaultAuth: NoAuthInjectionStrategyConfig = { type: 'NoAuth' };
    const securityManager = node.securityManager;
    const authorizer = this._authorizer ?? securityManager?.authorizer;
    if (
      !authorizer ||
      typeof authorizer.createReverseAuthorizationConfig !== 'function'
    ) {
      this._reverseAuthConfig = defaultAuth;
      return;
    }

    try {
      const config = await authorizer.createReverseAuthorizationConfig(node);
      this._reverseAuthConfig = config ?? defaultAuth;
    } catch (error) {
      logger.warning('reverse_auth_config_failure', {
        error: error instanceof Error ? error.message : String(error),
      });
      this._reverseAuthConfig = defaultAuth;
    }
  }
}

export function getHttpListenerInstance(): HttpListener | null {
  return _lastHttpListenerInstance;
}
