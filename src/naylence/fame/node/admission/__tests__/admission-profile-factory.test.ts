import { Expressions } from 'naylence-factory';
import type { AdmissionClient } from '../admission-client.js';
import { AdmissionClientFactory } from '../admission-client-factory.js';
import { AdmissionProfileFactory } from '../admission-profile-factory.js';

describe('AdmissionProfileFactory', () => {
  const fakeClient: AdmissionClient = {
    hasUpstream: true,
    async hello() {
      throw new Error('not implemented');
    },
    async close() {
      // noop
    },
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates the direct profile by default', async () => {
    const spy = jest
      .spyOn(AdmissionClientFactory, 'createAdmissionClient')
      .mockResolvedValue(fakeClient);

    const factory = new AdmissionProfileFactory();
    const result = await factory.create();

    expect(result).toBe(fakeClient);
    expect(spy).toHaveBeenCalledTimes(1);

    const [config] = spy.mock.calls[0];
    expect(config).toBeDefined();
    expect((config as Record<string, unknown>).type).toBe(
      'DirectAdmissionClient'
    );

    const grants =
      (config as { connection_grants?: Array<Record<string, unknown>> })
        .connection_grants ?? [];
    expect(Array.isArray(grants)).toBe(true);
    expect(grants.length).toBeGreaterThan(0);

    const grant = grants[0];
    expect(grant.type).toBe('WebSocketConnectionGrant');
    expect(grant.url).toBe(Expressions.env('FAME_DIRECT_ADMISSION_URL'));
    expect((grant.auth as Record<string, any>).token_provider.token_url).toBe(
      Expressions.env('FAME_ADMISSION_TOKEN_URL')
    );
  });

  it('maps welcome profile to welcome service client', async () => {
    const spy = jest
      .spyOn(AdmissionClientFactory, 'createAdmissionClient')
      .mockResolvedValue(fakeClient);

    const factory = new AdmissionProfileFactory();
    await factory.create({ profile: 'welcome' });

    const [config] = spy.mock.calls[0];
    expect((config as Record<string, unknown>).type).toBe(
      'WelcomeServiceClient'
    );

    const { auth, supported_transports: transports } = config as Record<
      string,
      any
    >;
    expect(transports).toEqual(['websocket']);
    expect(auth?.token_provider?.client_id).toBe(
      Expressions.env('FAME_ADMISSION_CLIENT_ID')
    );
  });

  it('supports noop profile aliases', async () => {
    const spy = jest
      .spyOn(AdmissionClientFactory, 'createAdmissionClient')
      .mockResolvedValue(fakeClient);

    const factory = new AdmissionProfileFactory();
    await factory.create({ profile: 'noop' });

    const [config] = spy.mock.calls[0];
    expect((config as Record<string, unknown>).type).toBe(
      'NoopAdmissionClient'
    );
    expect((config as Record<string, any>).auto_accept_logicals).toBe(true);
  });

  it('throws for unknown profiles', async () => {
    const factory = new AdmissionProfileFactory();
    await expect(
      factory.create({ profile: 'unknown-profile' })
    ).rejects.toThrow(/Unknown admission profile/);
  });
});
