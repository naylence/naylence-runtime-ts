import { installProcessEnvShim } from './_env-shim.js';

installProcessEnvShim();

// Browser entry point re-exporting shared runtime surface and browser-only modules.
export * from './runtime-isomorphic.js';
export {
  InPageConnector,
  INPAGE_CONNECTOR_TYPE,
  type InPageConnectorConfig,
} from './naylence/fame/connector/inpage-connector.js';
export {
  BroadcastChannelConnector,
  BROADCAST_CHANNEL_CONNECTOR_TYPE,
  type BroadcastChannelConnectorConfig,
} from './naylence/fame/connector/broadcast-channel-connector.js';
export {
  InPageConnectorFactory,
  type InPageConnectorFactoryConfig,
  FACTORY_META as INPAGE_CONNECTOR_FACTORY_META,
} from './naylence/fame/connector/inpage-connector-factory.js';
export {
  BroadcastChannelConnectorFactory,
  type BroadcastChannelConnectorFactoryConfig,
  FACTORY_META as BROADCAST_CHANNEL_CONNECTOR_FACTORY_META,
} from './naylence/fame/connector/broadcast-channel-connector-factory.js';
export { InPageListener } from './naylence/fame/connector/inpage-listener.js';
export {
  InPageListenerFactory,
  type InPageListenerFactoryConfig,
  FACTORY_META as INPAGE_LISTENER_FACTORY_META,
} from './naylence/fame/connector/inpage-listener-factory.js';
export { BroadcastChannelListener } from './naylence/fame/connector/broadcast-channel-listener.js';
export {
  BroadcastChannelListenerFactory,
  type BroadcastChannelListenerFactoryConfig,
  FACTORY_META as BROADCAST_CHANNEL_LISTENER_FACTORY_META,
} from './naylence/fame/connector/broadcast-channel-listener-factory.js';
