import {
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
} from './transport-listener-factory.js';
import type { TransportListener } from './transport-listener.js';
import type { TransportListenerConfig } from './transport-listener-config.js';
import { safeImport } from '../util/lazy-import.js';

type BroadcastChannelListenerModule =
  typeof import('./broadcast-channel-listener.js');

let broadcastChannelListenerModulePromise: Promise<BroadcastChannelListenerModule> | null =
  null;

function getBroadcastChannelListenerModule(): Promise<BroadcastChannelListenerModule> {
  if (!broadcastChannelListenerModulePromise) {
    broadcastChannelListenerModulePromise = safeImport(
      () => import('./broadcast-channel-listener.js'),
      'broadcast channel listener module'
    );
  }

  return broadcastChannelListenerModulePromise;
}

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

export interface BroadcastChannelListenerFactoryConfig
  extends TransportListenerConfig {
  type: 'BroadcastChannelListener';
  channelName?: string;
  channel_name?: string;
  inboxCapacity?: number;
  inbox_capacity?: number;
}

interface NormalizedConfig {
  type: 'BroadcastChannelListener';
  channelName: string;
  inboxCapacity: number;
}

function normalizeConfig(
  config?:
    | BroadcastChannelListenerFactoryConfig
    | Record<string, unknown>
    | null
): NormalizedConfig {
  const record = (config ?? {}) as Record<string, unknown>;

  const rawChannel = record.channelName ?? record['channel_name'];
  const channelName =
    typeof rawChannel === 'string' && rawChannel.trim().length > 0
      ? rawChannel.trim()
      : DEFAULT_CHANNEL;

  const rawInbox = record.inboxCapacity ?? record['inbox_capacity'];
  let inboxCapacity = DEFAULT_INBOX_CAPACITY;

  if (
    typeof rawInbox === 'number' &&
    Number.isFinite(rawInbox) &&
    rawInbox > 0
  ) {
    inboxCapacity = Math.floor(rawInbox);
  } else if (typeof rawInbox === 'string') {
    const parsed = Number.parseInt(rawInbox.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      inboxCapacity = Math.floor(parsed);
    }
  }

  return {
    type: 'BroadcastChannelListener',
    channelName,
    inboxCapacity,
  };
}

export const FACTORY_META = {
  base: TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  key: 'BroadcastChannelListener',
} as const;

export class BroadcastChannelListenerFactory extends TransportListenerFactory<BroadcastChannelListenerFactoryConfig> {
  public readonly type = 'BroadcastChannelListener';
  public readonly priority = 840;
  public readonly isDefault = false;

  public async create(
    config?:
      | BroadcastChannelListenerFactoryConfig
      | Record<string, unknown>
      | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);

    const [{ BroadcastChannelListener }] = await Promise.all([
      getBroadcastChannelListenerModule(),
    ]);

    void factoryArgs;

    return new BroadcastChannelListener({
      channelName: normalized.channelName,
      inboxCapacity: normalized.inboxCapacity,
    });
  }
}

export default BroadcastChannelListenerFactory;
