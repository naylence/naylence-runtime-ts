import {
  BaseAsyncConnector,
  type BaseAsyncConnectorConfig,
} from './base-async-connector.js';
import type { FameEnvelope, FameChannelMessage } from '@naylence/core';
import type { BroadcastChannelConnectorConfig } from './broadcast-channel-connector.browser.js';

export const BROADCAST_CHANNEL_CONNECTOR_TYPE =
  'broadcast-channel-connector' as const;

const ERROR_MESSAGE =
  'BroadcastChannelConnector is browser-only and requires BroadcastChannel support';

export class BroadcastChannelConnector extends BaseAsyncConnector {
  constructor(
    config: BroadcastChannelConnectorConfig,
    baseConfig: BaseAsyncConnectorConfig = {}
  ) {
    super(baseConfig);
    void config;
    throw new Error(ERROR_MESSAGE);
  }

  async pushToReceive(
    _rawOrEnvelope: Uint8Array | FameEnvelope | FameChannelMessage
  ): Promise<void> {
    throw new Error(ERROR_MESSAGE);
  }

  protected async _transportSendBytes(_data: Uint8Array): Promise<void> {
    throw new Error(ERROR_MESSAGE);
  }

  protected async _transportReceive(): Promise<
    Uint8Array | FameEnvelope | FameChannelMessage
  > {
    throw new Error(ERROR_MESSAGE);
  }

  protected async _transportClose(
    _code: number,
    _reason: string
  ): Promise<void> {
    throw new Error(ERROR_MESSAGE);
  }
}
