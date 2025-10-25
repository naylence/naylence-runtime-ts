import { FameTransportClose } from '../../errors/errors.js';
import {
  HttpStatelessConnector,
  QueueFullError,
  type HttpStatelessConnectorConfig,
} from '../http-stateless-connector.js';

describe('HttpStatelessConnector', () => {
  const createConfig = (
    overrides: Partial<HttpStatelessConnectorConfig> = {}
  ): HttpStatelessConnectorConfig => ({
    type: 'HttpStatelessConnector',
    url: 'https://example.test/outbox',
    maxQueue: 2,
    ...overrides,
  });

  it('sends bytes via fetch and includes auth header when present', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 202, statusText: 'Accepted' });
    const connector = new HttpStatelessConnector(createConfig(), {
      fetchImplementation: fetchMock,
    });

    connector.setAuthHeader('Bearer test-token');
    await connector['_transportSendBytes'](new Uint8Array([1, 2, 3]));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/outbox',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/octet-stream',
        }),
      })
    );

    await connector.close();
  });

  it('wraps transport errors as FameTransportClose', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('boom'));
    const connector = new HttpStatelessConnector(createConfig(), {
      fetchImplementation: fetchMock,
    });

    await expect(
      connector['_transportSendBytes'](new Uint8Array([0x1]))
    ).rejects.toBeInstanceOf(FameTransportClose);

    await connector.close();
  });

  it('delivers queued messages to the receive loop', async () => {
    const connector = new HttpStatelessConnector(createConfig(), {
      fetchImplementation: jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' }),
    });

    const payload = { frame: { type: 'Data' } } as any;
    await connector.pushToReceive(payload);

    const received = await connector['_transportReceive']();
    expect(received).toBe(payload);

    await connector.close();
  });

  it('throws when receive queue is full', async () => {
    const connector = new HttpStatelessConnector(
      createConfig({ maxQueue: 1 }),
      {
        fetchImplementation: jest
          .fn()
          .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' }),
      }
    );

    await connector.pushToReceive(new Uint8Array([1]));
    await expect(
      connector.pushToReceive(new Uint8Array([2]))
    ).rejects.toBeInstanceOf(QueueFullError);

    await connector.close();
  });

  it('rejects pending receive operations when closed', async () => {
    const connector = new HttpStatelessConnector(createConfig(), {
      fetchImplementation: jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' }),
    });

    const receivePromise = connector['_transportReceive']();
    await connector.close(1000, 'shutdown');

    await expect(receivePromise).rejects.toBeInstanceOf(FameTransportClose);
  });
});
