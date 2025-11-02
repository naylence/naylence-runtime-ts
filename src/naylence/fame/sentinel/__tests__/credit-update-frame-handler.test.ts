import type { FameDeliveryContext, FameEnvelope } from '@naylence/core';

import {
  CreditUpdateFrameHandler,
  type CreditUpdateFrameHandlerOptions,
} from '../credit-update-frame-handler.js';
import type { RouteManager } from '../route-manager.js';

describe('CreditUpdateFrameHandler', () => {
  const makeEnvelope = (overrides: Partial<FameEnvelope> = {}): FameEnvelope =>
    ({
      id: 'env-1',
      frame: { type: 'CreditUpdate' } as unknown,
      sec: undefined,
      meta: {},
      ...overrides,
    }) as FameEnvelope;

  it('accepts snake_case route_manager option and forwards credit updates', async () => {
    const send = jest.fn(async () => {});
    const targetConnector = { send };
    const routeManager = {
      getFlowRoute: jest.fn(() => targetConnector),
    } as unknown as RouteManager;

    const handler = new CreditUpdateFrameHandler({
      route_manager: routeManager,
    } as unknown as CreditUpdateFrameHandlerOptions);

    const envelope = makeEnvelope({ flowId: 'flow-1' });
    const context = { fromConnector: null } as FameDeliveryContext;

    await handler.acceptCreditUpdate(envelope, context);

    expect(routeManager.getFlowRoute).toHaveBeenCalledWith('flow-1');
    expect(send).toHaveBeenCalledWith(envelope);
  });

  it('skips sending when credit update originates from the same connector', async () => {
    const send = jest.fn(async () => {});
    const connector = { send };
    const routeManager = {
      getFlowRoute: jest.fn(() => connector),
    } as unknown as RouteManager;

    const handler = new CreditUpdateFrameHandler({ routeManager });

    const envelope = makeEnvelope({ flowId: 'flow-2' });
    const context = {
      fromConnector: connector,
    } as unknown as FameDeliveryContext;

    await handler.acceptCreditUpdate(envelope, context);

    expect(send).not.toHaveBeenCalled();
  });
});
