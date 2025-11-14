const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) {
  throw new Error('App root element #app not found');
}
const app = appElement;

const OAUTH_ORIGIN = import.meta.env.VITE_OAUTH_ORIGIN ?? 'http://127.0.0.1:8099';
const CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID ?? 'demo-client';
const SCOPE = import.meta.env.VITE_OAUTH_SCOPE ?? 'node.connect';
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `${window.location.origin}${REDIRECT_PATH}`;
const STORAGE_KEY_VERIFIER = 'pkce_code_verifier';
const STORAGE_KEY_STATE = 'pkce_state';

function clearSessionState(): void {
  sessionStorage.removeItem(STORAGE_KEY_VERIFIER);
  sessionStorage.removeItem(STORAGE_KEY_STATE);
}

function randomBytes(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return buffer;
}

function base64UrlEncode(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

async function computeS256(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function generateVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

function generateState(): string {
  return base64UrlEncode(randomBytes(24));
}

function setView(content: string): void {
  app.innerHTML = content;
}

function setError(message: string): void {
  setView(`<section class="card error"><h2>Authorization failed</h2><p>${message}</p><button id="retry-btn">Start over</button></section>`);
  document.getElementById('retry-btn')?.addEventListener('click', () => {
    clearSessionState();
    renderHome();
  });
}

async function startAuthorization(): Promise<void> {
  try {
    const verifier = generateVerifier();
    const challenge = await computeS256(verifier);
    const state = generateState();

    sessionStorage.setItem(STORAGE_KEY_VERIFIER, verifier);
    sessionStorage.setItem(STORAGE_KEY_STATE, state);

    const authorizeUrl = new URL('/oauth/authorize', OAUTH_ORIGIN);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString();

    window.location.assign(authorizeUrl.toString());
  } catch (error) {
    console.error('Failed to start authorization', error);
    setError('Could not initiate authorization. Check the console for details.');
  }
}

async function exchangeAuthorizationCode(code: string, state: string): Promise<void> {
  const storedVerifier = sessionStorage.getItem(STORAGE_KEY_VERIFIER);
  const storedState = sessionStorage.getItem(STORAGE_KEY_STATE);

  if (!storedVerifier || !storedState) {
    setError('Session expired. Please start the flow again.');
    return;
  }

  if (storedState !== state) {
    clearSessionState();
    setError('State mismatch detected. Flow cancelled.');
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: storedVerifier,
    });

    const response = await fetch('/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const fault = await response.json().catch(() => ({}));
      throw new Error(`Token endpoint returned ${response.status}: ${JSON.stringify(fault)}`);
    }

    const json = await response.json();
    clearSessionState();

    const formatted = JSON.stringify(json, null, 2);
    setView(`<section class="card success"><h2>Access token received</h2><pre>${formatted}</pre><button id="restart-btn">Request another token</button></section>`);
    document.getElementById('restart-btn')?.addEventListener('click', () => {
      renderHome();
    });
  } catch (error) {
    console.error('Token exchange failed', error);
    setError('Token exchange failed. Check the console for details.');
  }
}

function renderHome(): void {
  clearSessionState();
  setView(`<section class="card"><h1>OAuth Dev Server Demo</h1><p>This browser client demonstrates an authorization code + PKCE flow against the Naylence OAuth dev server.</p><ul><li>Client ID: <code>${CLIENT_ID}</code></li><li>Scope: <code>${SCOPE}</code></li><li>Redirect URI: <code>${REDIRECT_URI}</code></li></ul><button id="signin-btn">Sign in with Dev Server</button><p class="hint">You will be redirected to the developer login screen, then returned here with an authorization code.</p></section>`);
  document.getElementById('signin-btn')?.addEventListener('click', () => {
    void startAuthorization();
  });
}

function renderCallback(): void {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const errorDescription = params.get('error_description');

  if (error) {
    setError(`${error}${errorDescription ? `: ${errorDescription}` : ''}`);
    return;
  }

  if (!code || !state) {
    setError('Missing authorization response parameters.');
    return;
  }

  setView('<section class="card"><h2>Exchanging authorization code…</h2></section>');
  void exchangeAuthorizationCode(code, state);
}

function render(): void {
  if (window.location.pathname === REDIRECT_PATH) {
    renderCallback();
  } else {
    renderHome();
  }
}

function mountStyles(): void {
  const style = document.createElement('style');
  style.textContent = `:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, #0f172a, #020617 65%); color: #e2e8f0; }
#app { width: min(420px, calc(100vw - 32px)); }
.card { background: rgba(15, 23, 42, 0.92); border-radius: 16px; padding: 32px; box-shadow: 0 20px 45px rgba(15, 23, 42, 0.35); backdrop-filter: blur(18px); }
.card h1, .card h2 { margin-top: 0; font-weight: 600; }
.card ul { padding-left: 18px; color: rgba(226, 232, 240, 0.8); }
.card code { background: rgba(15, 23, 42, 0.65); padding: 2px 6px; border-radius: 6px; }
button { appearance: none; border: none; background: linear-gradient(135deg, #38bdf8, #818cf8); color: #0f172a; font-weight: 600; padding: 12px 16px; border-radius: 10px; cursor: pointer; width: 100%; margin-top: 16px; box-shadow: 0 12px 30px rgba(129, 140, 248, 0.35); transition: transform 0.15s ease; }
button:hover { transform: translateY(-1px); }
.hint { margin-top: 16px; color: rgba(148, 163, 184, 0.75); font-size: 0.9rem; }
.error { border: 1px solid rgba(248, 113, 113, 0.4); }
.success { border: 1px solid rgba(45, 212, 191, 0.4); }
pre { background: rgba(15, 23, 42, 0.75); border-radius: 12px; padding: 16px; overflow-x: auto; color: #cbd5f5; }
`;
  document.head.appendChild(style);
}

mountStyles();
render();
