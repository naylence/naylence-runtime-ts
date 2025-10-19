import {
  DeliveryOriginType,
  type FameDeliveryContext,
  type FameEnvelope,
  FameResponseType,
} from 'naylence-core';
import { ResponseContextManager } from '../response-context-manager.js';

describe('ResponseContextManager', () => {
  const createManager = () => new ResponseContextManager(() => 'system-123');

  it('creates response context with local origin and no expected reply', () => {
    const manager = createManager();
    const requestEnvelope = { id: 'req-1' } as FameEnvelope;
    const requestContext: FameDeliveryContext = {
      expectedResponseType: FameResponseType.STREAM,
      originType: DeliveryOriginType.UPSTREAM,
      fromSystemId: 'remote-system',
      security: {
        inboundCryptoLevel: 'required',
        inboundWasSigned: true,
        cryptoChannelId: 'channel-42',
        authorization: {
          authenticated: true,
          authorized: true,
          claims: {},
          grantedScopes: [],
          restrictions: {},
          principal: 'user-7',
        },
      },
    };

    const responseContext = manager.createResponseContext(
      requestEnvelope,
      requestContext
    );

    expect(responseContext.originType).toBe(DeliveryOriginType.LOCAL);
    expect(responseContext.fromSystemId).toBe('system-123');
    expect(responseContext.expectedResponseType).toBe(FameResponseType.NONE);
    expect(responseContext.security).toEqual(requestContext.security);
    expect(responseContext.security).not.toBe(requestContext.security);
  });

  it('ensures response metadata on provided context', () => {
    const manager = createManager();
    const requestEnvelope = { id: 'req-2' } as FameEnvelope;
    const responseEnvelope = { id: 'resp-2' } as FameEnvelope;
    const responseContext: FameDeliveryContext = {
      meta: {},
      originType: DeliveryOriginType.DOWNSTREAM,
      expectedResponseType: FameResponseType.NONE,
      fromSystemId: 'different-system',
    };

    manager.ensureResponseMetadata(
      responseEnvelope,
      requestEnvelope,
      responseContext
    );

    expect(responseContext.meta).toEqual({
      'message-type': 'response',
      'response-to-id': 'req-2',
    });
    expect(responseContext.originType).toBe(DeliveryOriginType.LOCAL);
    expect(responseContext.fromSystemId).toBe('system-123');
  });
});
