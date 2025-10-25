import { jest } from '@jest/globals';
import { createFameEnvelope, type FameEnvelope } from '@naylence/core';
import type { NodeLike } from '../../node/node-like.js';
import type { StorageProvider } from '../../storage/storage-provider.js';

describe('DefaultDeliveryTracker heartbeat logging', () => {
  let DefaultDeliveryTracker: typeof import('../default-delivery-tracker.js').DefaultDeliveryTracker;
  let utilModule: typeof import('../../util/util.js');
  let prettyModelSpy: jest.SpiedFunction<
    (typeof import('../../util/util.js'))['prettyModel']
  >;

  beforeEach(async () => {
    jest.resetModules();
    process.env.FAME_SHOW_ENVELOPES = 'true';
    utilModule = await import('../../util/util.js');
    prettyModelSpy = jest
      .spyOn(utilModule, 'prettyModel')
      .mockReturnValue('<formatted envelope>');
    ({ DefaultDeliveryTracker } = await import(
      '../default-delivery-tracker.js'
    ));
  });

  afterEach(() => {
    delete process.env.FAME_SHOW_ENVELOPES;
    prettyModelSpy.mockRestore();
    jest.restoreAllMocks();
  });

  function createStorageProvider(): StorageProvider {
    return {
      async getKeyValueStore() {
        return {
          async set() {
            /* no-op */
          },
          async get() {
            return null;
          },
          async update() {
            /* no-op */
          },
          async delete() {
            /* no-op */
          },
          async list() {
            return {};
          },
        };
      },
    } as StorageProvider;
  }

  it('logs only the envelope payload when heartbeat logging is enabled', async () => {
    const tracker = new DefaultDeliveryTracker(createStorageProvider());
    const consoleSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    const envelope: FameEnvelope = createFameEnvelope({
      frame: {
        type: 'NodeHeartbeat',
      },
    });

    const node = { id: 'node-1' } as unknown as NodeLike;

    await tracker.onHeartbeatSent(node, envelope);

    expect(prettyModelSpy).toHaveBeenCalledTimes(1);
    expect(prettyModelSpy).toHaveBeenCalledWith(envelope);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const loggedOutput = consoleSpy.mock.calls[0]?.[0];
    expect(typeof loggedOutput).toBe('string');
    expect(loggedOutput).toContain('<formatted envelope>');

    consoleSpy.mockRestore();
  });
});
