import type {
  DataFrame,
  SecureAcceptFrame,
  SecureCloseFrame,
  SecureOpenFrame,
} from 'naylence-core';

export interface SecureChannelState {
  readonly key: Uint8Array;
  readonly sendCounter: number;
  readonly receiveCounter: number;
  readonly noncePrefix: Uint8Array;
  readonly expiresAt: number;
  readonly algorithm: string;
}

export interface SecureChannelManager {
  readonly channels: Readonly<Record<string, SecureChannelState>>;

  generateOpenFrame(channelId: string, algorithm?: string): SecureOpenFrame;

  handleOpenFrame(frame: SecureOpenFrame): Promise<SecureAcceptFrame>;

  handleAcceptFrame(frame: SecureAcceptFrame): Promise<boolean>;

  handleCloseFrame(frame: SecureCloseFrame): void;

  isChannelEncrypted(frame: DataFrame): boolean;

  hasChannel(channelId: string): boolean;

  getChannelInfo(channelId: string): Record<string, unknown> | null;

  closeChannel(channelId: string, reason?: string): SecureCloseFrame;

  cleanupExpiredChannels(): number;

  addChannel(channelId: string, channelState: SecureChannelState): void;

  removeChannel(channelId: string): boolean;

  /**
   * Remove all channels for a given destination.
   * Used to cleanup stale channels when a route is removed or rebound.
   * @param destination The destination address
   * @returns Number of channels removed
   */
  removeChannelsForDestination(destination: string): number;
}
