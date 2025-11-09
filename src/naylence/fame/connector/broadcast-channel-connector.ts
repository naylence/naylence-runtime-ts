import {
  BroadcastChannelConnector as BrowserBroadcastChannelConnector,
  BROADCAST_CHANNEL_CONNECTOR_TYPE,
} from './broadcast-channel-connector.browser.js';
import { BroadcastChannelConnector as NodeBroadcastChannelConnector } from './broadcast-channel-connector.node.js';
import type { BroadcastChannelConnectorConfig } from './broadcast-channel-connector.browser.js';

const hasBroadcastChannelSupport =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as typeof globalThis & { BroadcastChannel?: unknown })
    .BroadcastChannel !== 'undefined';

type ConnectorConstructor = typeof BrowserBroadcastChannelConnector;

const ConnectorImpl: ConnectorConstructor = hasBroadcastChannelSupport
  ? BrowserBroadcastChannelConnector
  : (NodeBroadcastChannelConnector as unknown as ConnectorConstructor);

class BroadcastChannelConnector extends ConnectorImpl {}

export { BroadcastChannelConnector, BROADCAST_CHANNEL_CONNECTOR_TYPE };
export type { BroadcastChannelConnectorConfig };
