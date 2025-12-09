import { AdmissionClientFactory } from '../admission-client-factory.js';
import { AdmissionProfileFactory } from '../admission-profile-factory.js';
import type { AdmissionClient } from '../admission-client.js';

describe('AdmissionProfileFactory Args Passing', () => {
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

  it('passes factoryArgs to createAdmissionClient', async () => {
    const spy = jest
      .spyOn(AdmissionClientFactory, 'createAdmissionClient')
      .mockResolvedValue(fakeClient);

    const factory = new AdmissionProfileFactory();
    const mockIdentityPolicy = { resolveAdmissionNodeId: jest.fn() };
    const factoryArgs = [{ identityPolicy: mockIdentityPolicy }];

    await factory.create({ profile: 'direct' }, ...factoryArgs);

    expect(spy).toHaveBeenCalledTimes(1);
    const [config, options] = spy.mock.calls[0];
    
    expect(config).toBeDefined();
    expect(options).toBeDefined();
    expect(options?.factoryArgs).toEqual(factoryArgs);
  });
});
