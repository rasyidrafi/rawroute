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

The local Redis service is an intentionally empty runtime cache after cutover. Firestore migration imports all configuration/workspace documents and usage events/rollups on or after `MIGRATION_SINCE`. For a complete historical cutover, run the Firestore migration with an all-history cutoff, then run `npm run import:legacy-usage -- --input old-uage/9router-keyed-usage.sqlite` (the keyed export contains only `apiKeys` and usage fields, not request details). The importer matches exact API-key values, preserves the real workspace/key identity, uses the Asia/Jakarta calendar boundary, and replaces only the overlapping rollups covered by SQLite.

The complete backfill used `MIGRATION_SINCE=1970-01-01T00:00:00.000Z` and `LEGACY_USAGE_CUTOFF=2026-08-05T17:00:00.000Z` so SQLite supplies each real API key through the end of 5 August and Firestore supplies the older and newer periods. It does not create a synthetic or virtual API key.

Before cutover, run `npm run migrate:local`, then `npm run firestore:backfill-api-key-indexes` and `npm run verify:local` with the migration-only Firestore credentials available as `SOURCE_*` variables. Run these commands while PostgreSQL is reachable from the migration process. The migration result is a source snapshot; freeze or retire any old Firestore writer immediately after cutover. Do not run the destructive historical-row cleanup against a live local instance unless the source and local write streams have been deliberately merged.
