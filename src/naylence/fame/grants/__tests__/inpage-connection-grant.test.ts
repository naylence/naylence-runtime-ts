import { GRANT_PURPOSE_NODE_ATTACH } from '../grant.js';
import {
  INPAGE_CONNECTION_GRANT_TYPE,
  inPageGrantToConnectorConfig,
  normalizeInPageConnectionGrant,
} from '../inpage-connection-grant.js';

describe('normalizeInPageConnectionGrant', () => {
  it('defaults missing metadata', () => {
    const result = normalizeInPageConnectionGrant({
      channelName: 'shared-channel',
    });

    expect(result.type).toBe(INPAGE_CONNECTION_GRANT_TYPE);
    expect(result.purpose).toBe(GRANT_PURPOSE_NODE_ATTACH);
    expect(result.channelName).toBe('shared-channel');
  });

  it('accepts optional inbox capacity', () => {
    const result = normalizeInPageConnectionGrant({
      type: INPAGE_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
      inboxCapacity: 512.9,
    });

    expect(result.inboxCapacity).toBe(512);
    expect(result.purpose).toBe('connection');
  });

  it('rejects invalid channel names', () => {
    expect(() =>
      normalizeInPageConnectionGrant({
        type: INPAGE_CONNECTION_GRANT_TYPE,
        channelName: '',
      })
    ).toThrow(
      'InPageConnectionGrant "channelName" must be a non-empty string when provided'
    );
  });

  it('rejects non-positive inbox capacity', () => {
    expect(() =>
      normalizeInPageConnectionGrant({
        type: INPAGE_CONNECTION_GRANT_TYPE,
        inboxCapacity: 0,
      })
    ).toThrow(
      'InPageConnectionGrant "inboxCapacity" must be a positive number when provided'
    );
  });
});

describe('inPageGrantToConnectorConfig', () => {
  it('produces connector config from grant', () => {
    const config = inPageGrantToConnectorConfig({
      type: INPAGE_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
      channelName: 'custom-channel',
      inboxCapacity: 128,
    });

    expect(config).toEqual({
      type: 'inpage-connector',
      channelName: 'custom-channel',
      inboxCapacity: 128,
    });
  });
});
