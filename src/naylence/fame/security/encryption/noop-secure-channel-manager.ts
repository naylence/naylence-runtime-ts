import type {
  DataFrame,
  SecureAcceptFrame,
  SecureCloseFrame,
  SecureOpenFrame,
} from '@naylence/core';

import type {
  SecureChannelManager,
  SecureChannelState,
} from './secure-channel-manager.js';

const ZERO_EPHEMERAL_KEY_BASE64 =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function resolveAlgorithm(requested?: string): string {
  if (requested && requested.trim() !== '') {
    return requested;
  }

  return 'none';
}

export class NoopSecureChannelManager implements SecureChannelManager {
  public readonly channels: Readonly<Record<string, SecureChannelState>> =
    Object.freeze({});

  public generateOpenFrame(
    channelId: string,
    algorithm?: string
  ): SecureOpenFrame {
    const resolvedAlg = resolveAlgorithm(algorithm);

    return {
      type: 'SecureOpen',
      cid: channelId,
      ephPub: ZERO_EPHEMERAL_KEY_BASE64,
      alg: resolvedAlg,
      opts: 0,
    } satisfies SecureOpenFrame;
  }

  public async handleOpenFrame(
    frame: SecureOpenFrame
  ): Promise<SecureAcceptFrame> {
    return {
      type: 'SecureAccept',
      cid: frame.cid,
      ok: false,
      reason: 'secure_channel_manager_disabled',
      ephPub: ZERO_EPHEMERAL_KEY_BASE64,
      alg: resolveAlgorithm(frame.alg),
    } satisfies SecureAcceptFrame;
  }

  public async handleAcceptFrame(_frame: SecureAcceptFrame): Promise<boolean> {
    return false;
  }

  public handleCloseFrame(_frame: SecureCloseFrame): void {
    // No state to clean up for noop manager
  }

  public isChannelEncrypted(_frame: DataFrame): boolean {
    return false;
  }

  public hasChannel(_channelId: string): boolean {
    return false;
  }

  public getChannelInfo(_channelId: string): Record<string, unknown> | null {
    return null;
  }

  public closeChannel(
    channelId: string,
    reason = 'secure_channel_manager_disabled'
  ): SecureCloseFrame {
    return {
      type: 'SecureClose',
      cid: channelId,
      reason,
    } satisfies SecureCloseFrame;
  }

  public cleanupExpiredChannels(): number {
    return 0;
  }

  public addChannel(
    _channelId: string,
    _channelState: SecureChannelState
  ): void {
    // No state tracking for noop manager
  }

  public removeChannel(_channelId: string): boolean {
    return false;
  }

  public removeChannelsForDestination(_destination: string): number {
    return 0;
  }
}
