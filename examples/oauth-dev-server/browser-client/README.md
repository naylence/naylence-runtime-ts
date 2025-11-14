# Browser PKCE Client for the OAuth Dev Server

This Vite-powered single page app demonstrates an OAuth2 authorization-code flow with PKCE against the Naylence OAuth development server, including the cookie-backed developer login wall.

## Prerequisites

1. Build the runtime bundle once from the repository root:

   ```bash
   npm run build
   ```

2. Start the OAuth dev server (in another terminal):

   ```bash
   node ../start.mjs
   ```

   The script prints the default client configuration. Keep it running.

## Install & run the browser client

```bash
cd examples/oauth-dev-server/browser-client
npm install
npm run dev
```

Open the printed URL (defaults to `http://localhost:5174`). Click **“Sign in with Dev Server”** and authenticate with the dev credentials (default `devuser` / `devpass`). After login, the page exchanges the authorization code for an access token and displays the JSON payload.

### Environment overrides

Create a `.env.local` file to customise defaults:

```
VITE_OAUTH_ORIGIN=http://127.0.0.1:8099
VITE_OAUTH_CLIENT_ID=demo-client
VITE_OAUTH_SCOPE=node.connect telemetry.read
```

If you modify the client ID, scope, or redirect URI on the OAuth server, update the values here to match. The redirect URI is always `${window.location.origin}/callback`.

### Production build

To compile a static bundle:

```bash
npm run build
npm run preview
```

The preview server uses the same `/oauth` proxy to the dev server, so you can validate the flow without rebuilding the backend.
