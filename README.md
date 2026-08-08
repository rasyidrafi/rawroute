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
docker compose --env-file .env.local up --build
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

The ownership and feature-coverage audit is documented in [`docs/cliproxy-coverage.md`](docs/cliproxy-coverage.md). It records which behavior stays native to CLIProxyAPI and which behavior RawRoute adds around it.

## Verification

```bash
npm install
npm run lint
npm test
npx tsc --noEmit
npm run build
docker compose --env-file .env.local config
```

For deployment, run the zero-downtime handoff script from this directory:

```bash
./redeploy-rawroute-18080.sh
```

It builds the image, copies the live environment without printing secrets, preflights the new image on `:18081`, verifies health/browser/Traefik/public routes, drains the old `:18080` container, switches the direct port through a temporary NAT handoff, and retains the previous container for rollback. It prompts for sudo when needed. Override `RAWROUTE_PREFLIGHT_PORT`, `RAWROUTE_VERIFY_DOMAINS`, or other `RAWROUTE_*` settings when deploying a different environment. The detailed safety requirements remain in `AGENTS.md`.

PostgreSQL is the sole durable RawRoute data store. All workspace documents, provider/model catalogs, aliases, budgets, pricing, usage events, and rollups use the scoped canonical layout. Redis is only a disposable runtime cache for lookup, quota, and lock state; it is safe to flush after a deployment.

RawRoute does not require an external database migration at runtime. API-key ownership is indexed globally by RawRoute while every workspace resource remains under its workspace scope. Codex accounts are stored as credentials in RawRoute and synchronized to the private CLIProxyAPI backend; CLIProxyAPI models never become RawRoute providers or catalog records.
