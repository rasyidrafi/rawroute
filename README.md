# RawRoute

RawRoute is the public wrapper around a private CLIProxyAPI container pulled from its published image.

The original RawRoute dashboard remains intact, including workspaces, aliases, gateway keys, budgets, custom model pricing, usage analytics, Codex views, logs, and settings. RawRoute owns those wrapper features and the budget admission decision. CLIProxyAPI owns provider credentials, OAuth execution, protocol translation, retries, upstream routing, provider rate limits, and model execution.

## Network boundary

Only RawRoute binds a host port:

```text
client -> rawroute:8080 -> cli-proxy-api:8317 (private Compose network)
```

CLIProxyAPI uses `expose`, not `ports`. Its API, management API, and dashboard are not reachable from the host. RawRoute exposes only its own authenticated dashboard and wrapper endpoints.

## Setup

Requirements: Docker and Docker Compose.

```bash
cp .env.example .env.local
cp cliproxy/config.example.yaml cliproxy/config.yaml
# Put the same internal key in cliproxy/config.yaml and CLIPROXY_API_KEY.
docker compose up --build
```

Compose pulls `eceasy/cli-proxy-api:latest` from Docker Hub by default. Set `CLI_PROXY_IMAGE` in `.env.local` to use another published Docker Hub or GCR image/tag.

Replace all placeholder credentials before production use. The dashboard login is configured by `DEFAULT_ADMIN_USERNAME` and `DEFAULT_ADMIN_PASSWORD`.

## Wrapper behavior

RawRoute authenticates its gateway keys, resolves its retained aliases, applies its custom model pricing, reserves each key's RawRoute budget, and records usage. Requests that would exceed the configured budget are rejected with `429` before they reach CLIProxyAPI. The original dashboard and RawRoute-owned feature APIs remain available without exposing CLIProxyAPI management endpoints.

CLIProxyAPI-compatible traffic is forwarded through these wrapper paths:

- `/v1/*`
- `/v1beta/*`
- `/openai/v1/*`
- `/backend-api/codex/*`

OAuth callback paths needed by the dashboard are routed through RawRoute to the private CLIProxyAPI service. CLIProxyAPI's root, management API, and dashboard are never proxied to clients.

## Verification

```bash
npm install
npm run lint
npm test
npx tsc --noEmit
npm run build
docker compose config
```

For deployment, follow the handoff procedure in `AGENTS.md`; keep the live `rawroute` container on `:8080` serving traffic while the latest image is preflighted on `:18080`.
