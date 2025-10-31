# @naylence/runtime Browser Vite Example

This example demonstrates how to consume the browser-friendly entry point of
`@naylence/runtime` from a modern Vite application without relying on Node.js
polyfills. It performs a simple WebCrypto smoke test and exercises the
runtime factory registration helper.

## Getting Started

```sh
npm install
npm run dev
```

To validate the production build:

```sh
npm run build
npm run preview
```

The example depends on the local workspace build via the `file:../..`
dependency, so run `npm run build` from the repository root before building the
example.
