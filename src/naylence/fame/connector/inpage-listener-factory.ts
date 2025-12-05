import {
  TransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
} from './transport-listener-factory.js';
import type { TransportListener } from './transport-listener.js';
import type { TransportListenerConfig } from './transport-listener-config.js';
import { safeImport } from '../util/lazy-import.js';

type InPageListenerModule = typeof import('./inpage-listener.js');

let inPageListenerModulePromise: Promise<InPageListenerModule> | null = null;

function getInPageListenerModule(): Promise<InPageListenerModule> {
  if (!inPageListenerModulePromise) {
    inPageListenerModulePromise = safeImport(
      () => import('./inpage-listener.js'),
      'inpage listener module'
    );
  }

  return inPageListenerModulePromise;
}

const DEFAULT_CHANNEL = 'naylence-fabric';
const DEFAULT_INBOX_CAPACITY = 2048;

export interface InPageListenerFactoryConfig extends TransportListenerConfig {
  type: 'InPageListener';
  channelName?: string;
  channel_name?: string;
  inboxCapacity?: number;
  inbox_capacity?: number;
}

interface NormalizedConfig {
  type: 'InPageListener';
  channelName: string;
  inboxCapacity: number;
}

function normalizeConfig(
  config?: InPageListenerFactoryConfig | Record<string, unknown> | null
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
    type: 'InPageListener',
    channelName,
    inboxCapacity,
  };
}

export const FACTORY_META = {
  base: TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  key: 'InPageListener',
} as const;

export class InPageListenerFactory extends TransportListenerFactory<InPageListenerFactoryConfig> {
  public readonly type = 'InPageListener';
  public readonly priority = 850;
  public readonly isDefault = false;

  public async create(
    config?: InPageListenerFactoryConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);

    const [{ InPageListener }] = await Promise.all([getInPageListenerModule()]);

    void factoryArgs;

    return new InPageListener({
      channelName: normalized.channelName,
      inboxCapacity: normalized.inboxCapacity,
    });
  }
}

export default InPageListenerFactory;
