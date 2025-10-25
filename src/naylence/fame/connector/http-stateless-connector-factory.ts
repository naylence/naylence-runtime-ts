import {
  CONNECTOR_FACTORY_BASE_TYPE,
  ConnectorFactory,
} from './connector-factory.js';
import type { ConnectorConfig } from './connector-config.js';
import {
  HttpStatelessConnector,
  type HttpStatelessConnectorConfig,
} from './http-stateless-connector.js';
import type { ConnectionGrant } from '../grants/connection-grant.js';
import {
  HTTP_CONNECTION_GRANT_TYPE,
  HTTP_STATELESS_CONNECTOR_TYPE,
  httpGrantToConnectorConfig,
  normalizeHttpConnectionGrant,
  type HttpConnectionGrant,
  type HttpConnectionGrantLike,
  type HttpConnectionGrantAuth,
} from '../grants/http-connection-grant.js';
import {
  AuthInjectionStrategyFactory,
  type AuthInjectionStrategyConfig,
} from '../security/auth/auth-injection-strategy-factory.js';
import type { AuthInjectionStrategy } from '../security/auth/auth-injection-strategy.js';
import type { AuthorizationContext } from '@naylence/core';
import type { ExpressionEvaluationPolicy } from '@naylence/factory';

class HttpConnectionGrantImpl implements HttpConnectionGrant {
  public type = HTTP_CONNECTION_GRANT_TYPE;
  public purpose = 'connection';
  public url!: string;
  public auth?: HttpConnectionGrantAuth;
  [key: string]: unknown;
}

export interface HttpStatelessConnectorFactoryConfig extends ConnectorConfig {
  type: typeof HTTP_STATELESS_CONNECTOR_TYPE;
  url?: string;
  maxQueue?: number;
  auth?: HttpConnectionGrantAuth;
}

export interface CreateHttpStatelessConnectorOptions {
  systemId?: string;
  authorization?: AuthorizationContext;
  fetchImplementation?: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>;
  [key: string]: unknown;
}

export const FACTORY_META = {
  base: CONNECTOR_FACTORY_BASE_TYPE,
  key: HTTP_STATELESS_CONNECTOR_TYPE,
} as const;

export class HttpStatelessConnectorFactory extends ConnectorFactory<
  HttpStatelessConnector,
  HttpStatelessConnectorFactoryConfig
> {
  public readonly type = HTTP_STATELESS_CONNECTOR_TYPE;

  public supportedGrantTypes(): string[] {
    return [HTTP_CONNECTION_GRANT_TYPE, HTTP_STATELESS_CONNECTOR_TYPE];
  }

  public supportedGrants(): Record<string, new () => ConnectionGrant> {
    return {
      [HTTP_CONNECTION_GRANT_TYPE]: HttpConnectionGrantImpl,
    };
  }

  public configFromGrant(
    grant: ConnectionGrant | Record<string, unknown>,
    _expressionEvaluationPolicy: ExpressionEvaluationPolicy
  ): HttpStatelessConnectorFactoryConfig {
    const normalized = normalizeHttpConnectionGrant(
      grant as HttpConnectionGrantLike
    );
    const candidate = httpGrantToConnectorConfig(normalized);

    const config: HttpStatelessConnectorFactoryConfig = {
      type: HTTP_STATELESS_CONNECTOR_TYPE,
    };

    if (typeof candidate.url === 'string' && candidate.url.length > 0) {
      config.url = candidate.url;
    }

    if (candidate.auth !== undefined) {
      config.auth = candidate.auth;
    }

    return config;
  }

  public grantFromConfig(
    config: HttpStatelessConnectorFactoryConfig | Record<string, unknown>,
    _expressionEvaluationPolicy: ExpressionEvaluationPolicy
  ): HttpConnectionGrant {
    const normalized = this._normalizeConfig(config);

    const grantUrl = normalized.url;
    if (!grantUrl) {
      throw new Error(
        'HttpStatelessConnector config must provide a non-empty "url" value'
      );
    }

    const grant: HttpConnectionGrant = {
      type: HTTP_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
      url: grantUrl,
      auth: normalized.auth,
    };

    return grant;
  }

  public async create(
    config?:
      | HttpStatelessConnectorFactoryConfig
      | Record<string, unknown>
      | null,
    ...factoryArgs: unknown[]
  ): Promise<HttpStatelessConnector> {
    if (config == null) {
      throw new Error('HttpStatelessConnectorFactory requires a configuration');
    }

    const normalized = this._normalizeConfig(config);
    const options = (factoryArgs[0] ??
      {}) as CreateHttpStatelessConnectorOptions;

    let url = normalized.url;
    if (!url) {
      throw new Error('HttpStatelessConnector requires a URL');
    }

    if (options.systemId) {
      url = this._appendSystemId(url, options.systemId);
    }

    const finalUrl: string = url;

    const connectorConfig: HttpStatelessConnectorConfig = {
      type: HTTP_STATELESS_CONNECTOR_TYPE,
      url: finalUrl,
      maxQueue: normalized.maxQueue,
    };

    const connector = new HttpStatelessConnector(connectorConfig, {
      fetchImplementation: options.fetchImplementation,
    });

    if (options.authorization) {
      connector.authorizationContext = options.authorization;
    }

    let authStrategy: AuthInjectionStrategy | undefined;

    if (normalized.auth) {
      const authConfig = this._normalizeAuthConfig(normalized.auth);
      authStrategy =
        await AuthInjectionStrategyFactory.createAuthInjectionStrategy(
          authConfig
        );
      await authStrategy.apply(connector);
    }

    if (authStrategy) {
      const cleanup = async (): Promise<void> => {
        await authStrategy?.cleanup();
      };

      const originalStop = connector.stop.bind(connector);
      connector.stop = async (): Promise<void> => {
        try {
          await originalStop();
        } finally {
          await cleanup();
        }
      };

      const originalClose = connector.close.bind(connector);
      connector.close = async (
        code?: number,
        reason?: string
      ): Promise<void> => {
        try {
          await originalClose(code, reason);
        } finally {
          await cleanup();
        }
      };
    }

    return connector;
  }

  private _normalizeConfig(
    config: HttpStatelessConnectorFactoryConfig | Record<string, unknown>
  ): HttpStatelessConnectorFactoryConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration must be an object');
    }

    const type = (config as { type?: unknown }).type;
    if (type !== HTTP_STATELESS_CONNECTOR_TYPE) {
      throw new Error(
        `HttpStatelessConnectorFactory only supports ${HTTP_STATELESS_CONNECTOR_TYPE} config`
      );
    }

    const normalized: HttpStatelessConnectorFactoryConfig = {
      type: HTTP_STATELESS_CONNECTOR_TYPE,
    };

    const url = (config as { url?: unknown }).url;
    if (typeof url === 'string' && url.trim().length > 0) {
      normalized.url = url;
    }

    const maxQueue = (config as { maxQueue?: unknown }).maxQueue;
    if (typeof maxQueue === 'number' && Number.isFinite(maxQueue)) {
      normalized.maxQueue = maxQueue;
    }

    const auth = (config as { auth?: unknown }).auth;
    if (auth !== undefined) {
      normalized.auth = auth as HttpConnectionGrantAuth;
    }

    if ('flowControl' in config) {
      (normalized as Record<string, unknown>).flowControl = (
        config as { flowControl?: unknown }
      ).flowControl;
    }

    if ('maxQueueSize' in config) {
      (normalized as Record<string, unknown>).maxQueueSize = (
        config as { maxQueueSize?: unknown }
      ).maxQueueSize;
    }

    if ('initialWindow' in config) {
      (normalized as Record<string, unknown>).initialWindow = (
        config as { initialWindow?: unknown }
      ).initialWindow;
    }

    if ('taskSpawner' in config) {
      (normalized as Record<string, unknown>).taskSpawner = (
        config as { taskSpawner?: unknown }
      ).taskSpawner;
    }

    if ('authorizationContext' in config) {
      (normalized as Record<string, unknown>).authorizationContext = (
        config as { authorizationContext?: unknown }
      ).authorizationContext;
    }

    if ('drainTimeout' in config) {
      (normalized as Record<string, unknown>).drainTimeout = (
        config as { drainTimeout?: unknown }
      ).drainTimeout;
    }

    return normalized;
  }

  private _normalizeAuthConfig(
    auth: HttpConnectionGrantAuth
  ): AuthInjectionStrategyConfig {
    if (!auth || typeof auth !== 'object') {
      throw new Error(
        'Authentication configuration must be an object with a type property'
      );
    }

    const type = (auth as { type?: unknown }).type;
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error(
        'Authentication configuration requires a non-empty "type" property'
      );
    }

    return auth as AuthInjectionStrategyConfig;
  }

  private _appendSystemId(url: string, systemId: string): string {
    if (!systemId) {
      return url;
    }

    if (url.endsWith('/')) {
      return `${url}${systemId}`;
    }

    return `${url}/${systemId}`;
  }
}

export default HttpStatelessConnectorFactory;
