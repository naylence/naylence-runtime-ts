import { webcrypto } from 'node:crypto';
import {
  OAuth2PkceRedirectInitiatedError,
  OAuth2PkceTokenProvider,
} from '../auth/oauth2-pkce-token-provider.js';
import type { OAuth2PkceTokenProviderOptions } from '../auth/oauth2-pkce-token-provider.js';
import type { CredentialProvider } from '../credential/credential-provider.js';

type MockBrowser = ReturnType<typeof createMockBrowser>;

function createMockBrowser(initialHref = 'http://localhost/app') {
  const storage = new Map<string, string>();
  const sessionStorage: Storage = {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };

  const urlState = { current: new URL(initialHref) };
  const assignedUrls: string[] = [];

  const location: Partial<Location> & {
    assign: jest.Mock<void, [string]>;
  } = {
    get href() {
      return urlState.current.toString();
    },
    set href(value: string) {
      urlState.current = new URL(value, urlState.current);
    },
    get origin() {
      return urlState.current.origin;
    },
    get pathname() {
      return urlState.current.pathname;
    },
    get search() {
      return urlState.current.search;
    },
    get hash() {
      return urlState.current.hash;
    },
    assign: jest.fn((href: string) => {
      assignedUrls.push(new URL(href, urlState.current).toString());
    }),
  };

  const historyState = { value: null as unknown };
  const history: Partial<History> = {
    get state() {
      return historyState.value;
    },
    length: 1,
    scrollRestoration: 'auto',
    back: jest.fn(),
    forward: jest.fn(),
    go: jest.fn(),
    pushState: jest.fn(),
    replaceState: jest.fn(
      (state: unknown, _title: string, url?: string | URL | null) => {
        historyState.value = state;
        if (url !== undefined && url !== null) {
          urlState.current = new URL(url.toString(), urlState.current);
        }
      }
    ),
  };

  return {
    window: {
      location: location as Location,
      history: history as History,
      sessionStorage,
    },
    assignedUrls,
    updateUrl: (href: string) => {
      urlState.current = new URL(href, urlState.current);
    },
    clearStorage: () => storage.clear(),
    get currentUrl() {
      return urlState.current;
    },
  };
}

describe('OAuth2PkceTokenProvider (browser)', () => {
  class StaticCredentialProvider implements CredentialProvider {
    constructor(private readonly value: string) {}

    async get(): Promise<string> {
      return this.value;
    }
  }

  const authorizeUrl = 'https://auth.example.com/oauth2/authorize';
  const tokenUrl = 'https://auth.example.com/oauth2/token';
  const redirectUri = 'http://localhost/callback';
  const clientId = 'pkce-client';
  const storageKey = `naylence.oauth2_pkce.${clientId}`;

  let originalCrypto: Crypto | undefined;
  let originalWindow: unknown;
  let originalLocation: unknown;
  let originalHistory: unknown;
  let originalSessionStorage: unknown;
  let browser: MockBrowser;

  beforeAll(() => {
    originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    browser = createMockBrowser();
    const globalAny = globalThis as Record<string, unknown>;
    originalWindow = globalAny.window;
    originalLocation = globalAny.location;
    originalHistory = globalAny.history;
    originalSessionStorage = globalAny.sessionStorage;
    globalAny.window = browser.window;
    globalAny.location = browser.window.location;
    globalAny.history = browser.window.history;
    globalAny.sessionStorage = browser.window.sessionStorage;
    browser.window.sessionStorage.clear();
  });

  afterEach(() => {
    const globalAny = globalThis as Record<string, unknown>;
    if (originalWindow === undefined) {
      delete globalAny.window;
    } else {
      globalAny.window = originalWindow;
    }
    if (originalLocation === undefined) {
      delete globalAny.location;
    } else {
      globalAny.location = originalLocation;
    }
    if (originalHistory === undefined) {
      delete globalAny.history;
    } else {
      globalAny.history = originalHistory;
    }
    if (originalSessionStorage === undefined) {
      delete globalAny.sessionStorage;
    } else {
      globalAny.sessionStorage = originalSessionStorage;
    }
    jest.clearAllMocks();
  });

  const buildProvider = (
    overrides: Partial<OAuth2PkceTokenProviderOptions> = {}
  ): OAuth2PkceTokenProvider =>
    new OAuth2PkceTokenProvider({
      authorizeUrl,
      tokenUrl,
      redirectUri,
      clientId,
      ...overrides,
    } as OAuth2PkceTokenProviderOptions);

  it('redirects the browser and exchanges tokens after the callback returns', async () => {
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        expect(input).toBe(tokenUrl);
        const params = new URLSearchParams(body);
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('redirect_uri')).toBe(redirectUri);
        expect(params.get('client_id')).toBe(clientId);
        expect(params.get('code')).toBe('auth-code');
        expect(params.get('code_verifier')).toBeTruthy();
        return new Response(
          JSON.stringify({ access_token: 'pkce-token', expires_in: 60 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    );

    const provider = buildProvider({
      fetchImpl,
      scopes: ['scope:a'],
      usernameProvider: new StaticCredentialProvider('hint-user'),
    });

    await expect(provider.getToken()).rejects.toThrow(
      OAuth2PkceRedirectInitiatedError
    );

    expect(browser.window.location.assign).toHaveBeenCalledTimes(1);
    const authorizeCall = (browser.window.location.assign as jest.Mock).mock
      .calls[0][0] as string;
    const authorizeLocation = new URL(authorizeCall);
    expect(authorizeLocation.searchParams.get('response_type')).toBe('code');
    expect(authorizeLocation.searchParams.get('client_id')).toBe(clientId);
    expect(authorizeLocation.searchParams.get('scope')).toBe('scope:a');
    expect(authorizeLocation.searchParams.get('login_hint')).toBe('hint-user');

    const stored = window.sessionStorage.getItem(storageKey);
    expect(stored).toBeTruthy();
    const pending = JSON.parse(stored ?? '{}') as {
      state: string;
      codeVerifier: string;
      authorizeUrl: string;
    };
    expect(pending.state).toBeTruthy();
    expect(pending.codeVerifier).toBeTruthy();
    expect(new URL(pending.authorizeUrl).origin).toBe(
      new URL(authorizeUrl).origin
    );

    browser.updateUrl(
      `/callback?code=auth-code&state=${encodeURIComponent(pending.state)}`
    );

    const providerAfterRedirect = buildProvider({ fetchImpl });
    const token = await providerAfterRedirect.getToken();
    expect(token.value).toBe('pkce-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(window.location.search).toBe('');

    const cached = await providerAfterRedirect.getToken();
    expect(cached.value).toBe('pkce-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('clears pending state and throws when redirected with mismatched state', async () => {
    const provider = buildProvider();
    await expect(provider.getToken()).rejects.toThrow(
      OAuth2PkceRedirectInitiatedError
    );

    const stored = window.sessionStorage.getItem(storageKey);
    const pending = JSON.parse(stored ?? '{}') as { state: string };
    expect(pending.state).toBeTruthy();

    browser.updateUrl('/callback?code=auth-code&state=unexpected-state');

    await expect(buildProvider().getToken()).rejects.toThrow(
      'Authorization state mismatch'
    );
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it('surfaces authorization errors returned by the identity provider', async () => {
    const provider = buildProvider();
    await expect(provider.getToken()).rejects.toThrow(
      OAuth2PkceRedirectInitiatedError
    );

    const stored = window.sessionStorage.getItem(storageKey);
    const pending = JSON.parse(stored ?? '{}') as { state: string };

    browser.updateUrl(
      `/callback?error=access_denied&error_description=denied&state=${encodeURIComponent(pending.state)}`
    );

    await expect(buildProvider().getToken()).rejects.toThrow(
      'OAuth2 authorization failed: access_denied - denied'
    );
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });
});
