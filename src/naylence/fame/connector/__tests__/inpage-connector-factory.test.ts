import { ExpressionEvaluationPolicy } from '@naylence/factory';

import { InPageConnectorFactory } from '../inpage-connector-factory.js';
import { INPAGE_CONNECTION_GRANT_TYPE } from '../../grants/inpage-connection-grant.js';

describe('InPageConnectorFactory', () => {
  const factory = new InPageConnectorFactory();

  it('advertises the in-page grant type', () => {
    expect(factory.supportedGrantTypes()).toEqual([
      INPAGE_CONNECTION_GRANT_TYPE,
      'inpage-connector',
    ]);
  });

  it('converts grants to config', () => {
    const config = factory.configFromGrant(
      {
        type: INPAGE_CONNECTION_GRANT_TYPE,
        purpose: 'connection',
        channelName: 'shared-tab',
        inboxCapacity: 256,
      },
      ExpressionEvaluationPolicy.ERROR
    );

    expect(config).toEqual({
      type: 'inpage-connector',
      channelName: 'shared-tab',
      inboxCapacity: 256,
    });
  });

  it('converts config back to grants', () => {
    const grant = factory.grantFromConfig(
      {
        type: 'inpage-connector',
        channelName: 'shared-tab',
        inboxCapacity: 256,
      },
      ExpressionEvaluationPolicy.ERROR
    );

    expect(grant).toEqual({
      type: INPAGE_CONNECTION_GRANT_TYPE,
      purpose: 'connection',
      channelName: 'shared-tab',
      inboxCapacity: 256,
    });
  });

  it('requires a local node id when creating connectors', async () => {
    await expect(
      factory.create({
        type: 'inpage-connector',
      })
    ).rejects.toThrow(/localNodeId/);
  });
});
