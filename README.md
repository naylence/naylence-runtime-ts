[![Join our Discord](https://img.shields.io/badge/Discord-Join%20Chat-blue?logo=discord)](https://discord.gg/nwZAeqdv7y)

# Naylence Runtime (TypeScript)

> Message fabric, connectors, listeners, and security primitives that power Naylence agents, nodes and sentinels. This package provides the **runtime substrate**—not the high‑level Agent SDK or tutorials.

---

## What this is

**@naylence/runtime** is the foundational TypeScript/JavaScript library that implements:

* **FAME fabric** (in‑process and networked) for routing envelopes between clients, agents, and sentinels.
* **Connectors & listeners** for WebSocket/HTTP transports, back‑pressure, flow control, and streaming.
* **Profiles & admission**: pluggable admission flows (e.g., token‑based), logical addressing, and attach APIs.
* **Security building blocks**: envelope signing, overlay encryption, JWT/JWKS helpers, and identity hooks.
* **Cross-platform support**: runs in Node.js and browser environments with unified APIs.

It is meant to be **embedded** by the Agent SDK, sentinels, and security add‑ons. Most users should not call it directly unless they're extending transports, writing custom admission, or integrating Naylence into an existing control plane.

---

## When to use (and when not)

Use **@naylence/runtime** if you need to:

* Build or customize **transport connectors/listeners**.
* Implement or extend **admission/identity** flows.
* Operate a bespoke **sentinel** or welcome/CA services.
* Integrate Naylence into browser-based or Node.js applications.

Prefer the higher‑level packages for day‑to‑day development:

* **Naylence Agent SDK (TypeScript)** — idiomatic agent APIs & ergonomics. → Coming soon
* **Naylence Examples (TypeScript)** — runnable learning path & patterns. → Coming soon

For Python development, refer to:

* **Naylence Agent SDK (Python)** → [https://github.com/naylence/naylence-agent-sdk-python](https://github.com/naylence/naylence-agent-sdk-python)
* **Naylence Examples (Python)** → [https://github.com/naylence/naylence-examples-python](https://github.com/naylence/naylence-examples-python)

If you're just getting started, learn with the **Agent SDK** and **Examples** first; drop down to **Runtime** only when you need lower‑level control.

---

## Security profiles

The runtime exposes security primitives used by sentinels and agents through **profiles**:

* **direct** — no admission; useful for local/dev.
* **gated** — OAuth2/JWT‑gated admission; TLS via your reverse proxy.
* **strict‑overlay** — sealed, end‑to‑end overlay encryption with SPIFFE/X.509‑style identities.

> **Important:** The **strict‑overlay** profile is supported **only** when the **`@naylence/advanced-security`** package is installed. Install that add‑on to enable sealed channels and SVID‑backed identities.

---

## Installation

```bash
npm install @naylence/runtime
```

---

## Relationship to other repos

* **Runtime (TypeScript):** [https://github.com/naylence/naylence-runtime-ts](https://github.com/naylence/naylence-runtime-ts)
* **Runtime (Python):** [https://github.com/naylence/naylence-runtime-python](https://github.com/naylence/naylence-runtime-python)
* **Agent SDK (Python):** [https://github.com/naylence/naylence-agent-sdk-python](https://github.com/naylence/naylence-agent-sdk-python)
* **Examples (Python):** [https://github.com/naylence/naylence-examples-python](https://github.com/naylence/naylence-examples-python)
* **Advanced Security add‑on (Python):** [https://github.com/naylence/naylence-advanced-security-python](https://github.com/naylence/naylence-advanced-security-python)

---

## What this README intentionally omits

This page explains **purpose and scope** only. It does **not** include code samples, quick starts, or container recipes. For that:

* Start with the **Agent SDK** docs and examples to learn the development model.
* Refer to the **Examples** repository for runnable demos from simple to distributed to security‑hardened.

---

## Support & license

* **Issues:** open tickets in the corresponding repository (Runtime, SDK, Examples, or Advanced Security) based on where the problem belongs.
* **License:** Apache‑2.0.