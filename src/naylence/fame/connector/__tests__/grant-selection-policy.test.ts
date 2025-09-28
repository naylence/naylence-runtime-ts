import type { NodeAttachFrame } from 'naylence-core';

import {
	GrantSelectionContext,
	GrantSelectionPolicy,
	type GrantSelectionContextInit,
	type SerializedGrant,
} from '../grant-selection-policy.js';
import {
	HTTP_CONNECTION_GRANT_TYPE,
	HTTP_STATELESS_CONNECTOR_TYPE,
} from '../../grants/http-connection-grant.js';
import { WEBSOCKET_CONNECTION_GRANT_TYPE } from '../../grants/websocket-connection-grant.js';

jest.mock('../../util/logging.js', () => {
	return {
		getLogger: () => ({
			debug: jest.fn(),
			warning: jest.fn(),
		}),
	};
});

function createContext(
	overrides: Partial<GrantSelectionContextInit> & { callbackGrants?: SerializedGrant[] | undefined }
) {
	const { callbackGrants, ...rest } = overrides;
	const attachFrame =
		callbackGrants === undefined
			? ({} as Record<string, unknown>)
			: ({ callbackGrants } as Record<string, unknown>);

	return new GrantSelectionContext({
		childId: 'child-1',
		attachFrame: attachFrame as unknown as NodeAttachFrame,
		callbackGrantType: 'UnknownGrant',
		node: {} as GrantSelectionContextInit['node'],
		...rest,
	});
}

function clone(serialized: SerializedGrant): SerializedGrant {
	return JSON.parse(JSON.stringify(serialized));
}

describe('GrantSelectionContext', () => {
	test('clientSupportedCallbackGrants returns empty array when missing', () => {
		const context = createContext({ callbackGrants: undefined });
		expect(context.clientSupportedCallbackGrants).toEqual([]);
	});

	test('clientSupportedCallbackGrants filters invalid entries', () => {
		const validGrant: SerializedGrant = { type: 'ValidGrant', purpose: 'connection' };
		const context = createContext({
			callbackGrants: [null, 'string', {}, validGrant, []] as unknown as SerializedGrant[],
		});
		const grants = context.clientSupportedCallbackGrants;
		expect(grants).toHaveLength(1);
		expect(grants[0]).toEqual(validGrant);
		expect(grants[0]).not.toBe(validGrant);
	});
});

describe('GrantSelectionPolicy', () => {
	test('selects matching inbound connector type without fallback', () => {
		const httpGrant: SerializedGrant = {
			type: HTTP_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
			url: 'https://primary.example.com',
			auth: { header: 'auth-token' },
		};
		const policy = new GrantSelectionPolicy();
		const context = createContext({
			callbackGrantType: HTTP_CONNECTION_GRANT_TYPE,
			callbackGrants: [clone(httpGrant)],
		});

		const result = policy.selectCallbackGrant(context);

		expect(result.fallbackUsed).toBe(false);
		expect(result.selectionReason).toContain('Matching inbound connector type');
		expect(result.grant.type).toBe(HTTP_CONNECTION_GRANT_TYPE);
		expect(result.grant.toConnectorConfig?.()).toEqual({
			type: HTTP_STATELESS_CONNECTOR_TYPE,
			url: 'https://primary.example.com',
			auth: { header: 'auth-token' },
		});
	});

	test('ignores malformed websocket grant before selecting valid match', () => {
		const malformedWebsocket: SerializedGrant = {
			type: WEBSOCKET_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
			url: '',
		};
		const validWebsocket: SerializedGrant = {
			type: WEBSOCKET_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
			url: 'wss://primary.example.com',
		};
		const policy = new GrantSelectionPolicy();
		const context = createContext({
			callbackGrantType: WEBSOCKET_CONNECTION_GRANT_TYPE,
			callbackGrants: [clone(malformedWebsocket), clone(validWebsocket)],
		});

		const result = policy.selectCallbackGrant(context);

		expect(result.grant.type).toBe(WEBSOCKET_CONNECTION_GRANT_TYPE);
		expect(result.fallbackUsed).toBe(false);
		expect(result.selectionReason).toContain('Matching inbound connector type');
		expect(result.grant.toConnectorConfig?.()).toEqual({
			type: 'WebSocketConnector',
			url: 'wss://primary.example.com',
		});
	});

	test('prefers HTTP grant after skipping invalid option', () => {
		const invalidHttp: SerializedGrant = {
			type: HTTP_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
		};
		const validHttp: SerializedGrant = {
			type: HTTP_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
			url: 'https://fallback.example.com',
		};
		const policy = new GrantSelectionPolicy();
		const context = createContext({
			callbackGrantType: WEBSOCKET_CONNECTION_GRANT_TYPE,
			callbackGrants: [clone(invalidHttp), clone(validHttp)],
		});

		const result = policy.selectCallbackGrant(context);

		expect(result.grant.type).toBe(HTTP_CONNECTION_GRANT_TYPE);
		expect(result.fallbackUsed).toBe(true);
		expect(result.grant.toConnectorConfig?.()).toEqual({
			type: HTTP_STATELESS_CONNECTOR_TYPE,
			url: 'https://fallback.example.com',
		});
	});

	test('falls back to client preference when no matching strategies succeed', () => {
		const websocketGrant: SerializedGrant = {
			type: WEBSOCKET_CONNECTION_GRANT_TYPE,
			purpose: 'connection',
			url: 'wss://client.example.com',
			auth: { apiKey: '123' },
		};
		const policy = new GrantSelectionPolicy();
		const context = createContext({
			callbackGrantType: 'CustomConnector',
			callbackGrants: [clone(websocketGrant)],
		});

		const result = policy.selectCallbackGrant(context);

		expect(result.grant.type).toBe(WEBSOCKET_CONNECTION_GRANT_TYPE);
		expect(result.fallbackUsed).toBe(true);
		expect(result.selectionReason).toContain("Client's first preference");
		expect(result.grant.toConnectorConfig?.()).toEqual({
			type: 'WebSocketConnector',
			url: 'wss://client.example.com',
			auth: { apiKey: '123' },
		});
	});

	test('throws descriptive error when no suitable grant is found', () => {
		const unsupported: SerializedGrant = {
			type: 'UnsupportedGrant',
			purpose: 'connection',
		};
		const policy = new GrantSelectionPolicy();
		const context = createContext({
			childId: 'child-42',
			callbackGrantType: 'AnotherConnector',
			callbackGrants: [clone(unsupported)],
		});

		expect(() => policy.selectCallbackGrant(context)).toThrow(
			'No suitable connector found for child child-42. Client supports: UnsupportedGrant, inbound type: AnotherConnector',
		);
	});

	test('throws descriptive error when client provides no callback grants', () => {
		const policy = new GrantSelectionPolicy();
		const context = createContext({
			childId: 'child-99',
			callbackGrantType: HTTP_CONNECTION_GRANT_TYPE,
			callbackGrants: [],
		});

		expect(() => policy.selectCallbackGrant(context)).toThrow(
			'No suitable connector found for child child-99. Client supports: , inbound type: HttpConnectionGrant',
		);
	});
});
