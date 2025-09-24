/**
 * WebSocket Connector Factory
 * 
 * Factory for creating WebSocket connectors that work across Node.js and browser environments.
 * Supports multiple authentication strategies and automatic WebSocket client creation.
 */

import { WebSocketConnector, WebSocketConnectorConfig, WebSocketLike, AuthorizationContext } from './websocket-connector.js';
import { 
  ConnectorFactory, 
  ConnectionGrant, 
  ExpressionEvaluationPolicy 
} from './connector-factory.js';
import { ConnectorConfig } from './connector-config.js';
import { FameConnectError } from '../errors/errors.js';
import { getLogger } from '../util/logging.js';

const logger = getLogger('websocket-connector-factory');

/**
 * WebSocket connection grant configuration
 */
export interface WebSocketConnectionGrant extends ConnectionGrant {
  type: 'WebSocketConnectionGrant';
  purpose: string;
  url?: string | undefined;
  auth?: AuthInjectionStrategyConfig | undefined;
}

/**
 * Auth injection strategy configuration
 */
export interface AuthInjectionStrategyConfig {
  type: string;
  [key: string]: any;
}

/**
 * Configuration for WebSocket connector factory
 */
export interface WebSocketConnectorFactoryConfig extends ConnectorConfig {
  type: 'WebSocketConnector';
  url?: string | undefined;
  auth?: AuthInjectionStrategyConfig | undefined;
}

/**
 * Options for creating WebSocket connectors
 */
export interface CreateWebSocketConnectorOptions {
  /** Pre-existing WebSocket instance */
  websocket?: WebSocketLike;
  /** System ID to append to URL */
  systemId?: string;
  /** Custom WebSocket client factory function */
  clientFactory?: (url: string, protocols?: string[], headers?: Record<string, string>) => Promise<WebSocketLike>;
}

/**
 * WebSocket connection grant implementation
 */
class WebSocketConnectionGrantImpl implements WebSocketConnectionGrant {
  type: 'WebSocketConnectionGrant' = 'WebSocketConnectionGrant';
  purpose: string = 'connection';
  url?: string;
  auth?: AuthInjectionStrategyConfig;
  
  [key: string]: unknown;
}

/**
 * Auth injection strategy interface
 */
export interface AuthInjectionStrategy {
  /** Get subprotocols for WebSocket connection */
  getSubprotocols?(): Promise<string[]> | string[];
  /** Modify connection URL */
  modifyUrl?(url: string): Promise<string> | string;
  /** Apply auth strategy to connector after connection */
  apply(connector: WebSocketConnector): Promise<void>;
}

/**
 * Factory for creating WebSocket connectors with authentication support
 */
export class WebSocketConnectorFactory extends ConnectorFactory<WebSocketConnector, WebSocketConnectorFactoryConfig> {
  readonly type = 'WebSocketConnector';
  
  private readonly _clientFactory: (url: string, protocols?: string[], headers?: Record<string, string>) => Promise<WebSocketLike>;

  constructor(clientFactory?: (url: string, protocols?: string[], headers?: Record<string, string>) => Promise<WebSocketLike>) {
    super();
    this._clientFactory = clientFactory || this._defaultWebSocketClient;
  }

  /**
   * Return list of connection grant types that this factory can handle.
   */
  public supportedGrantTypes(): string[] {
    return ['WebSocketConnectionGrant', 'WebSocketConnector'];
  }

  /**
   * Return mapping of connection grant types to their classes.
   */
  public supportedGrants(): Record<string, new () => ConnectionGrant> {
    return {
      'WebSocketConnectionGrant': WebSocketConnectionGrantImpl,
    };
  }

  /**
   * Create a ConnectorConfig instance from a connection grant or dictionary.
   */
  public configFromGrant(
    grant: ConnectionGrant | Record<string, unknown>,
    _expressionEvaluationPolicy?: ExpressionEvaluationPolicy
  ): WebSocketConnectorFactoryConfig {
    let websocketGrant: WebSocketConnectionGrant;

    // Handle dictionary case - validate and convert
    if ('type' in grant && typeof grant === 'object') {
      if (grant.type !== 'WebSocketConnectionGrant') {
        throw new Error(
          `WebSocketConnectorFactory only supports WebSocketConnectionGrant, got type ${grant.type}`
        );
      }
      websocketGrant = grant as WebSocketConnectionGrant;
    } else {
      throw new Error(
        `WebSocketConnectorFactory only supports WebSocketConnectionGrant, got ${typeof grant}`
      );
    }

    return {
      type: 'WebSocketConnector',
      url: websocketGrant.url,
      auth: websocketGrant.auth,
    };
  }

  /**
   * Create a ConnectionGrant instance from a connector config or dictionary.
   */
  public grantFromConfig(
    config: WebSocketConnectorFactoryConfig | Record<string, unknown>,
    _expressionEvaluationPolicy?: ExpressionEvaluationPolicy
  ): WebSocketConnectionGrant {
    let websocketConfig: WebSocketConnectorFactoryConfig;

    // Handle dictionary case - validate and convert
    if ('type' in config && typeof config === 'object') {
      if (config.type !== 'WebSocketConnector') {
        throw new Error(
          `WebSocketConnectorFactory only supports WebSocketConnector config, got type ${config.type}`
        );
      }
      websocketConfig = config as WebSocketConnectorFactoryConfig;
    } else {
      throw new Error(
        `WebSocketConnectorFactory only supports WebSocketConnector config, got ${typeof config}`
      );
    }

    return {
      type: 'WebSocketConnectionGrant',
      purpose: 'connection',
      url: websocketConfig.url,
      auth: websocketConfig.auth,
    };
  }

  /**
   * Create a WebSocket connector
   */
  async create(
    config: WebSocketConnectorFactoryConfig | Record<string, any>,
    options: CreateWebSocketConnectorOptions = {}
  ): Promise<WebSocketConnector> {
    let connectorConfig: WebSocketConnectorFactoryConfig;

    // Convert dictionary to typed config if needed
    if ('type' in config) {
      connectorConfig = config as WebSocketConnectorFactoryConfig;
    } else {
      throw new Error('Config must have a type field');
    }

    // Create auth strategy if configured
    let authStrategy: AuthInjectionStrategy | undefined;
    if (connectorConfig.auth) {
      authStrategy = await this._createAuthStrategy(connectorConfig.auth);
    }

    let authorizationContext: AuthorizationContext | undefined;
    let websocket: WebSocketLike;

    if (options.websocket) {
      // Use provided WebSocket instance
      websocket = options.websocket;
    } else {
      // Create new WebSocket connection
      if (!connectorConfig.url) {
        throw new Error('WebSocket URL must be provided in config');
      }

      let url = connectorConfig.url;
      let subprotocols: string[] | undefined;
      let headers: Record<string, string> | undefined;

      // Apply auth strategy to modify connection parameters
      if (authStrategy) {
        if (authStrategy.getSubprotocols) {
          const protocols = await authStrategy.getSubprotocols();
          subprotocols = Array.isArray(protocols) ? protocols : [protocols];
        }
        if (authStrategy.modifyUrl) {
          url = await authStrategy.modifyUrl(url);
        }
      }

      // Append system ID if provided
      if (options.systemId) {
        url = url + `/${options.systemId}`;
      }

      // Use custom client factory if provided, otherwise use default
      const clientFactory = options.clientFactory || this._clientFactory;
      websocket = await clientFactory(url, subprotocols, headers);
      
      authorizationContext = {
        authenticated: true,
        authorized: true,
        claims: {},
        grantedScopes: [],
        restrictions: {},
      };
    }

    // Create connector
    const finalConfig: WebSocketConnectorConfig = {
      // Map the factory config to connector config
      // WebSocketConnectorConfig extends BaseAsyncConnectorConfig and has authorizationContext
      authorizationContext,
    };
    
    const connector = new WebSocketConnector(websocket, finalConfig);

    // Apply post-connection auth strategy if needed
    if (authStrategy) {
      await authStrategy.apply(connector);
    }

    return connector;
  }

  /**
   * Create auth strategy from configuration
   */
  private async _createAuthStrategy(config: AuthInjectionStrategyConfig): Promise<AuthInjectionStrategy> {
    switch (config.type) {
      case 'WebSocketSubprotocolStrategy':
        return new WebSocketSubprotocolStrategy(config);
      case 'QueryParamStrategy':
        return new QueryParamStrategy(config);
      case 'HeaderStrategy':
        return new HeaderStrategy(config);
      default:
        logger.warning('unknown_auth_strategy', { type: config.type });
        return new NoOpAuthStrategy();
    }
  }

  /**
   * Default WebSocket client factory
   */
  private async _defaultWebSocketClient(
    url: string,
    subprotocols?: string[],
    headers?: Record<string, string>
  ): Promise<WebSocketLike> {
    try {
      logger.debug('websocket_connector_connecting', { url });

      // Detect environment and create appropriate WebSocket
      if (typeof window !== 'undefined' && window.WebSocket) {
        // Browser environment
        const ws = new WebSocket(url, subprotocols);
        
        // Wait for connection to open
        return new Promise<WebSocketLike>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new FameConnectError(`Connection timeout to ${url}`));
          }, 5000);

          ws.onopen = () => {
            clearTimeout(timeoutId);
            resolve(ws as WebSocketLike);
          };

          ws.onerror = (event) => {
            clearTimeout(timeoutId);
            reject(new FameConnectError(`Failed to connect to ${url}: ${event}`));
          };
        });
      } else {
        // Node.js environment - try to use ws library
        try {
          // Dynamic import to avoid bundling issues - only try if in Node.js
          let wsModule: any;
          try {
            // Use eval to prevent TypeScript from analyzing the import at compile time
            const dynamicImport = new Function('specifier', 'return import(specifier)');
            wsModule = await dynamicImport('ws');
          } catch (importError) {
            throw new Error('ws package not found');
          }
          
          const WebSocket = wsModule.default || (wsModule as any).WebSocket || wsModule;
          
          const ws = new (WebSocket as any)(url, subprotocols, {
            headers,
            handshakeTimeout: 5000,
            // Support custom SSL certificates via environment
            ...(process.env.SSL_CERT_FILE && url.startsWith('wss://') && {
              ca: await this._loadSslCertificate(),
            }),
          });

          return new Promise<WebSocketLike>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new FameConnectError(`Connection timeout to ${url}`));
            }, 5000);

            ws.on('open', () => {
              clearTimeout(timeoutId);
              resolve(ws as any);
            });

            ws.on('error', (error: Error) => {
              clearTimeout(timeoutId);
              reject(new FameConnectError(`Failed to connect to ${url}: ${error.message}`));
            });
          });
        } catch (error) {
          throw new FameConnectError(
            `WebSocket library not available. Install 'ws' package for Node.js support: ${error}`
          );
        }
      }
    } catch (error) {
      if (error instanceof FameConnectError) {
        throw error;
      }
      throw new FameConnectError(`Cannot connect to ${url}: ${error}`);
    }
  }

  /**
   * Load SSL certificate from SSL_CERT_FILE environment variable
   */
  private async _loadSslCertificate(): Promise<Buffer | undefined> {
    const certFile = process.env.SSL_CERT_FILE;
    if (!certFile) return undefined;

    try {
      const fs = await import('fs');
      return fs.readFileSync(certFile);
    } catch (error) {
      logger.warning('ssl_certificate_load_failed', {
        cert_file: certFile,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

// -------------------------------------------------------------------------
// Auth Strategy Implementations
// -------------------------------------------------------------------------

/**
 * No-op auth strategy that does nothing
 */
class NoOpAuthStrategy implements AuthInjectionStrategy {
  async apply(_connector: WebSocketConnector): Promise<void> {
    // Do nothing
  }
}

/**
 * WebSocket subprotocol auth strategy
 */
class WebSocketSubprotocolStrategy implements AuthInjectionStrategy {
  constructor(private config: AuthInjectionStrategyConfig) {}

  async getSubprotocols(): Promise<string[]> {
    const token = this.config.token || this.config.accessToken;
    if (!token) {
      throw new Error('Token required for WebSocket subprotocol auth strategy');
    }
    return [`access_token.${token}`];
  }

  async apply(_connector: WebSocketConnector): Promise<void> {
    // Subprotocol auth is applied during connection
  }
}

/**
 * Query parameter auth strategy
 */
class QueryParamStrategy implements AuthInjectionStrategy {
  constructor(private config: AuthInjectionStrategyConfig) {}

  async modifyUrl(url: string): Promise<string> {
    const token = this.config.token || this.config.accessToken;
    if (!token) {
      throw new Error('Token required for query param auth strategy');
    }

    const separator = url.includes('?') ? '&' : '?';
    const paramName = this.config.paramName || 'access_token';
    return `${url}${separator}${paramName}=${encodeURIComponent(token)}`;
  }

  async apply(_connector: WebSocketConnector): Promise<void> {
    // Query param auth is applied during connection
  }
}

/**
 * Header auth strategy (mainly for server-side WebSockets)
 */
class HeaderStrategy implements AuthInjectionStrategy {
  constructor(private config: AuthInjectionStrategyConfig) {}

  async apply(connector: WebSocketConnector): Promise<void> {
    const token = this.config.token || this.config.accessToken;
    if (!token) {
      throw new Error('Token required for header auth strategy');
    }

    // Set authorization context
    connector.authorizationContext = {
      authenticated: true,
      authorized: true,
      principal: this.config.principal,
      claims: { token },
      grantedScopes: this.config.scopes || [],
      restrictions: {},
      authMethod: 'header',
    };
  }
}