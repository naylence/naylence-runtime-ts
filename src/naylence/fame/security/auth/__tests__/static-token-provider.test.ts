import { StaticTokenProvider } from '../static-token-provider.js';

describe('StaticTokenProvider', () => {
  it('extracts identity from a valid JWT', async () => {
    // {"sub":"test-subject","name":"Test User"}
    const payload = Buffer.from(
      JSON.stringify({ sub: 'test-subject', name: 'Test User' })
    ).toString('base64url');
    const token = `header.${payload}.signature`;

    const provider = new StaticTokenProvider({ token });
    const identity = await provider.getIdentity();

    expect(identity).toBeDefined();
    expect(identity?.subject).toBe('test-subject');
    expect(identity?.claims).toEqual({
      sub: 'test-subject',
      name: 'Test User',
    });
  });

  it('returns undefined for non-JWT tokens', async () => {
    const provider = new StaticTokenProvider({ token: 'simple-token' });
    const identity = await provider.getIdentity();

    expect(identity).toBeUndefined();
  });

  it('returns undefined for JWT without sub claim', async () => {
    const payload = Buffer.from(JSON.stringify({ name: 'Test User' })).toString(
      'base64url'
    );
    const token = `header.${payload}.signature`;

    const provider = new StaticTokenProvider({ token });
    const identity = await provider.getIdentity();

    expect(identity).toBeUndefined();
  });
});
