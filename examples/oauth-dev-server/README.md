# OAuth Dev Server with PKCE + Login

This example shows how to launch the Naylence OAuth development server with PKCE support and the optional cookie-backed developer login wall, then exercise the entire authorization-code flow from a script client.

## Prerequisites

- Node.js 18 or newer (top-level `await` and built-in fetch are used)
- Project dependencies installed (`npm install` or `pnpm install` in the repository root)

## 1. Build the runtime once

```bash
npm run build
```

The example loads the compiled ESM output under `dist/esm`, so building is required whenever the source changes.

## 2. Start the local OAuth server

```bash
node examples/oauth-dev-server/start.mjs
```

The script sets sensible defaults:

- Client credentials: `demo-client` / `demo-secret`
- Allowed scopes: `node.connect telemetry.read`
- Developer login: enabled with username `devuser` and password `devpass`
- Server origin: `http://127.0.0.1:8099`

Override any value by exporting the matching environment variable before launching (for example `export FAME_OAUTH_DEV_PASSWORD=my-pass`).

Keep this process running while you experiment.

## 3. Run the scripted PKCE flow (optional)

In a second terminal, execute:

```bash
node examples/oauth-dev-server/pkce-client.mjs
```

The client script:

1. Generates a PKCE verifier/challenge pair
2. Follows the `/oauth/login` redirect, submits the developer credentials, and stores the session cookie
3. Completes the authorization redirect and exchanges the code for a JWT access token

You will see the issued token and decoded payload in the console.

## 4. Try the flow in a browser (optional)

Open the authorize URL printed by `start.mjs` in a browser. After authenticating with the developer credentials, you are redirected to the configured callback URI with the authorization code appended. Use any HTTP client to exchange the code via `/oauth/token`.

---

Feel free to copy these scripts into your own sandbox or combine them with a front-end app to simulate OAuth-integrated sign-in during local development.
