# RawRoute

RawRoute is the public wrapper around a private CLIProxyAPI container pulled from its published image.

The original RawRoute dashboard remains intact, including workspaces, aliases, gateway keys, budgets, custom model pricing, usage analytics, Codex views, logs, and settings. RawRoute owns those wrapper features and the budget admission decision. CLIProxyAPI owns provider credentials, OAuth execution, protocol translation, retries, upstream routing, provider rate limits, and model execution.

## Network boundary

Only RawRoute binds a host port. CLIProxyAPI remains the private provider
execution and translation service; provider requests use the configured
upstream base URL directly.

```text
client -> rawroute:8080 -> cli-proxy-api:8317 (private Compose network)
                              -> provider origin
```

CLIProxyAPI uses `expose`, not `ports`, so its management API is not reachable
from the host. RawRoute synchronizes workspace-scoped provider projections to
CLIProxyAPI; it does not proxy or rewrite provider traffic itself.

## Setup

Requirements: Docker and Docker Compose.

```bash
cp .env.example .env.local
cp cliproxy/config.example.yaml cliproxy/config.yaml
# Put the same internal key in cliproxy/config.yaml and CLIPROXY_API_KEY.
docker compose --env-file .env.local up --build
```

Compose pulls `eceasy/cli-proxy-api:latest` from Docker Hub by default. Set `CLI_PROXY_IMAGE` in `.env.local` to use another published Docker Hub or GCR image/tag.

`Enable CLIProxy prompt cache key support` is an opt-in provider setting. It
projects CLIProxy's native `support-prompt-cache-key` option for
OpenAI-compatible providers without adding RawRoute-side cache-key or user
rewriting.

Replace all placeholder credentials before production use. The dashboard login is configured by `DEFAULT_ADMIN_USERNAME` and `DEFAULT_ADMIN_PASSWORD`.

## Wrapper behavior

RawRoute authenticates its gateway keys, resolves its retained aliases, applies its custom model pricing, reserves each key's RawRoute budget, and records usage. Requests that would exceed the configured budget are rejected with `429` before they reach CLIProxyAPI. The original dashboard and RawRoute-owned feature APIs remain available without exposing CLIProxyAPI management endpoints.

For direct OpenAI/Codex models, successful responses with complete usage are
used to calibrate later missing-usage estimates against serialized request-body
size. Settlement uses the nearby-history median (p50); admission reservations
use a conservative p75 input/output estimate and p25 cache-read estimate.
Observed cache-write tokens are used only when history contains them—there is
no fixed per-request cache-write charge. Other providers retain the generic
fallback estimator. Set `BUDGET_PAYLOAD_PREDICTION_ENABLED=0` to disable this
calibration.

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

RawRoute does not require an external database migration at runtime. API-key ownership is indexed globally by RawRoute while every workspace resource remains under its workspace scope. Codex OAuth credentials live only in the private CLIProxyAPI backend; RawRoute stores only the workspace-to-auth-file mapping and live management metadata. CLIProxyAPI models never become RawRoute providers or catalog records.
