import { WebSocketConnector, type WebSocketLike, type WebSocketConnectorConfig, type AuthorizationContext } from './websocket-connector.js';
import { ConnectorFactory, ExpressionEvaluationPolicy } from './connector-factory.js';
import type { ConnectorConfig } from './connector-config.js';
import { FameConnectError } from '../errors/errors.js';
import { getLogger } from '../util/logging.js';
import type { ConnectionGrant } from '../grants/connection-grant.js';
import {
	normalizeWebSocketConnectionGrant,
	websocketGrantToConnectorConfig,
	WEBSOCKET_CONNECTION_GRANT_TYPE,
	type WebSocketConnectionGrant,
	type WebSocketConnectionGrantLike,
	type WebSocketConnectionGrantAuth,
} from '../grants/websocket-connection-grant.js';
import {
	AuthInjectionStrategyFactory,
	type AuthInjectionStrategyConfig,
} from '../security/auth/auth-injection-strategy-factory.js';
import type { AuthInjectionStrategy } from '../security/auth/auth-injection-strategy.js';

const logger = getLogger('websocket-connector-factory');

export interface WebSocketConnectorFactoryConfig extends ConnectorConfig {
	type: 'WebSocketConnector';
	url?: string;
	auth?: WebSocketConnectionGrantAuth;
}

export interface CreateWebSocketConnectorOptions {
	websocket?: WebSocketLike;
	systemId?: string;
	clientFactory?: (url: string, subprotocols?: string[], headers?: Record<string, string>) => Promise<WebSocketLike>;
	headers?: Record<string, string>;
}

class WebSocketConnectionGrantImpl implements WebSocketConnectionGrant {
	public type = WEBSOCKET_CONNECTION_GRANT_TYPE;
	public purpose = 'connection';
	public url?: string;
	public auth?: WebSocketConnectionGrantAuth;
	[key: string]: unknown;
}

type SubprotocolCapableStrategy = AuthInjectionStrategy & {
	getSubprotocols?: () => Promise<string[] | string> | string[] | string;
};

type UrlMutatingStrategy = AuthInjectionStrategy & {
	modifyUrl?: (url: string) => Promise<string> | string;
};

export class WebSocketConnectorFactory extends ConnectorFactory<WebSocketConnector, WebSocketConnectorFactoryConfig> {
	public readonly type = 'WebSocketConnector';

	private readonly _clientFactory: (url: string, subprotocols?: string[], headers?: Record<string, string>) => Promise<WebSocketLike>;

	public constructor(
		clientFactory?: (url: string, subprotocols?: string[], headers?: Record<string, string>) => Promise<WebSocketLike>
	) {
		super();
		this._clientFactory = clientFactory ?? this._defaultWebSocketClient.bind(this);
	}

	public supportedGrantTypes(): string[] {
		return [WEBSOCKET_CONNECTION_GRANT_TYPE, 'WebSocketConnector'];
	}

	public supportedGrants(): Record<string, new () => ConnectionGrant> {
		return {
			[WEBSOCKET_CONNECTION_GRANT_TYPE]: WebSocketConnectionGrantImpl,
		};
	}

	public configFromGrant(
		grant: ConnectionGrant | Record<string, unknown>,
		_expressionEvaluationPolicy: ExpressionEvaluationPolicy = ExpressionEvaluationPolicy.ERROR
	): WebSocketConnectorFactoryConfig {
		const normalizedGrant = normalizeWebSocketConnectionGrant(grant as WebSocketConnectionGrantLike);
		const candidate = websocketGrantToConnectorConfig(normalizedGrant);

		const config: WebSocketConnectorFactoryConfig = {
			type: 'WebSocketConnector',
		};

		if (typeof candidate.url === 'string') {
			config.url = candidate.url;
		}

		if (candidate.auth !== undefined) {
			config.auth = candidate.auth;
		}

		return config;
	}

	public grantFromConfig(
		config: WebSocketConnectorFactoryConfig | Record<string, unknown>,
		_expressionEvaluationPolicy: ExpressionEvaluationPolicy = ExpressionEvaluationPolicy.ERROR
	): WebSocketConnectionGrant {
		if (!this._isWebSocketConnectorConfig(config)) {
			const type = (config as { type?: unknown }).type;
			throw new Error(
				`WebSocketConnectorFactory only supports WebSocketConnector config, got type ${
					typeof type === 'string' ? type : String(type)
				}`
			);
		}

		const grantCandidate: WebSocketConnectionGrantLike = {
			type: WEBSOCKET_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
			url: config.url,
			auth: config.auth,
		};

		return normalizeWebSocketConnectionGrant(grantCandidate);
	}

	public async create(
		config: WebSocketConnectorFactoryConfig | Record<string, unknown>,
		options: CreateWebSocketConnectorOptions = {}
	): Promise<WebSocketConnector> {
		const normalizedConfig = this._normalizeConfig(config);

		const headers = options.headers;

		let authStrategy: AuthInjectionStrategy | undefined;
		if (normalizedConfig.auth !== undefined) {
			const authConfig = this._normalizeAuthConfig(normalizedConfig.auth);
			authStrategy = await AuthInjectionStrategyFactory.createAuthInjectionStrategy(authConfig);
		}

		let websocket = options.websocket;
		let authorizationContext: AuthorizationContext | undefined;

		if (!websocket) {
			const baseUrl = normalizedConfig.url;
			if (!baseUrl) {
				throw new Error('WebSocket URL must be provided in config when websocket instance is not supplied');
			}

			const subprotocols = await this._maybeGetSubprotocols(authStrategy);
			let url = await this._maybeModifyUrl(authStrategy, baseUrl);

			if (options.systemId) {
				url = this._appendSystemId(url, options.systemId);
			}

			const clientFactory = options.clientFactory ?? this._clientFactory;
			websocket = await clientFactory(url, subprotocols, headers);
			authorizationContext = this._buildAuthorizationContext();
		}

		const connectorConfig: WebSocketConnectorConfig = {
			authorizationContext,
		};

		const connector = new WebSocketConnector(websocket, connectorConfig);

		if (authStrategy) {
			await authStrategy.apply(connector);
		}

		return connector;
	}

	private _normalizeConfig(config: WebSocketConnectorFactoryConfig | Record<string, unknown>): WebSocketConnectorFactoryConfig {
		if (!this._isWebSocketConnectorConfig(config)) {
			const type = (config as { type?: unknown }).type;
			throw new Error(
				`WebSocketConnectorFactory only supports WebSocketConnector config, got type ${
					typeof type === 'string' ? type : String(type)
				}`
			);
		}

		const normalized: WebSocketConnectorFactoryConfig = {
			type: 'WebSocketConnector',
		};

		if (typeof config.url === 'string' && config.url.length > 0) {
			normalized.url = config.url;
		}

		if (config.auth !== undefined) {
			normalized.auth = config.auth;
		}

		return normalized;
	}

	private _normalizeAuthConfig(auth: WebSocketConnectionGrantAuth): AuthInjectionStrategyConfig {
		if (!auth || typeof auth !== 'object') {
			throw new Error('Authentication configuration must be an object with a type property');
		}

		const type = (auth as { type?: unknown }).type;
		if (typeof type !== 'string' || type.length === 0) {
			throw new Error('Authentication configuration requires a non-empty "type" property');
		}

		return auth as AuthInjectionStrategyConfig;
	}

	private async _maybeGetSubprotocols(strategy: AuthInjectionStrategy | undefined): Promise<string[] | undefined> {
		if (!strategy) {
			return undefined;
		}

		const candidate = strategy as SubprotocolCapableStrategy;
		if (typeof candidate.getSubprotocols !== 'function') {
			return undefined;
		}

		const result = await candidate.getSubprotocols();
		if (Array.isArray(result)) {
			return result;
		}

		if (typeof result === 'string' && result.length > 0) {
			return [result];
		}

		return undefined;
	}

	private async _maybeModifyUrl(strategy: AuthInjectionStrategy | undefined, url: string): Promise<string> {
		if (!strategy) {
			return url;
		}

		const candidate = strategy as UrlMutatingStrategy;
		if (typeof candidate.modifyUrl !== 'function') {
			return url;
		}

		const result = await candidate.modifyUrl(url);
		return typeof result === 'string' && result.length > 0 ? result : url;
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

	private _buildAuthorizationContext(): AuthorizationContext {
		const context = {
			authenticated: true,
			authorized: true,
			claims: {},
			grantedScopes: [],
			restrictions: {},
		} as AuthorizationContext;

		return context;
	}

	private _isWebSocketConnectorConfig(candidate: unknown): candidate is WebSocketConnectorFactoryConfig {
		if (!candidate || typeof candidate !== 'object') {
			return false;
		}

		const type = (candidate as { type?: unknown }).type;
		if (type !== 'WebSocketConnector') {
			return false;
		}

		const url = (candidate as { url?: unknown }).url;
		if (url !== undefined && typeof url !== 'string') {
			return false;
		}

		return true;
	}

	private async _defaultWebSocketClient(
		url: string,
		subprotocols?: string[],
		headers?: Record<string, string>
	): Promise<WebSocketLike> {
		try {
			logger.debug('websocket_connector_connecting', { url, subprotocols });

			if (typeof window !== 'undefined' && typeof window.WebSocket !== 'undefined') {
				return await this._createBrowserWebSocket(url, subprotocols);
			}

			return await this._createNodeWebSocket(url, subprotocols, headers);
		} catch (error) {
			if (error instanceof FameConnectError) {
				throw error;
			}
			throw new FameConnectError(`Cannot connect to ${url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _createBrowserWebSocket(url: string, subprotocols?: string[]): Promise<WebSocketLike> {
		return await new Promise<WebSocketLike>((resolve, reject) => {
			try {
				const websocket = new WebSocket(url, subprotocols);

				const timeoutId = setTimeout(() => {
					websocket.close();
					reject(new FameConnectError(`Connection timeout to ${url}`));
				}, 5000);

				websocket.onopen = () => {
					clearTimeout(timeoutId);
					resolve(websocket as unknown as WebSocketLike);
				};

				websocket.onerror = (event: Event) => {
					clearTimeout(timeoutId);
					reject(new FameConnectError(`Failed to connect to ${url}: ${event}`));
				};
			} catch (error) {
				reject(new FameConnectError(`Failed to create WebSocket: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
	}

		private async _createNodeWebSocket(
			url: string,
			subprotocols?: string[],
			headers?: Record<string, string>
		): Promise<WebSocketLike> {
		try {
			const wsModule = await import('ws');
			const WebSocketConstructor = (wsModule as { default?: unknown }).default ?? (wsModule as unknown as { WebSocket: unknown }).WebSocket ?? wsModule;

				const ca = url.startsWith('wss://') ? await this._loadSslCertificate() : undefined;

			return await new Promise<WebSocketLike>((resolve, reject) => {
				try {
					const websocket = new (WebSocketConstructor as new (...args: unknown[]) => WebSocketLike)(url, subprotocols, {
						headers,
						handshakeTimeout: 5000,
							...(ca ? { ca } : {}),
					});

					const timeoutId = setTimeout(() => {
						reject(new FameConnectError(`Connection timeout to ${url}`));
					}, 5000);

					(websocket as any).on('open', () => {
						clearTimeout(timeoutId);
						resolve(websocket);
					});

					(websocket as any).on('error', (connectionError: Error) => {
						clearTimeout(timeoutId);
						reject(new FameConnectError(`Failed to connect to ${url}: ${connectionError.message}`));
					});
				} catch (error) {
					reject(error);
				}
			});
		} catch (importError) {
			throw new FameConnectError(
				`WebSocket library not available. Install 'ws' package for Node.js support: ${
					importError instanceof Error ? importError.message : String(importError)
				}`
			);
		}
	}

			private async _loadSslCertificate(): Promise<Buffer | undefined> {
				if (typeof process === 'undefined') {
					return undefined;
				}

				const certFile = process.env.SSL_CERT_FILE;
				if (!certFile) {
					return undefined;
				}

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
