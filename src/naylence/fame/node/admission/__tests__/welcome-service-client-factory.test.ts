import { WelcomeServiceClient } from '../welcome-service-client.js';
import { WelcomeServiceClientFactory } from '../welcome-service-client-factory.js';

describe('WelcomeServiceClientFactory', () => {
  it('creates a welcome service client when supportedTransports are provided', async () => {
    const factory = new WelcomeServiceClientFactory();
    const client = await factory.create({
      type: 'WelcomeServiceClient',
      url: 'https://example.test/welcome',
      supportedTransports: ['websocket'],
      isRoot: false,
    });

    expect(client).toBeInstanceOf(WelcomeServiceClient);
  });

  it('throws if supportedTransports are missing or empty', async () => {
    const factory = new WelcomeServiceClientFactory();

    await expect(
      factory.create({
        type: 'WelcomeServiceClient',
        url: 'https://example.test/welcome',
        isRoot: false,
      } as unknown as Parameters<WelcomeServiceClientFactory['create']>[0])
    ).rejects.toThrow('supportedTransports');

    await expect(
      factory.create({
        type: 'WelcomeServiceClient',
        url: 'https://example.test/welcome',
        supportedTransports: [],
      } as unknown as Parameters<WelcomeServiceClientFactory['create']>[0])
    ).rejects.toThrow('supportedTransports');
  });
});
