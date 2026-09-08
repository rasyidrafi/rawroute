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

The ready-to-use image is published on [Docker Hub](https://hub.docker.com/r/rasyidrafi/rawroute)
as `rasyidrafi/rawroute:latest`. Compose pulls it by default; no local build or Bun
installation is needed. Set `RAWROUTE_IMAGE` to a `sha-<commit>` tag or image digest
to pin a release. GitHub Actions publishes images after lint, unit tests, the
production build, and TypeScript checks pass.

For a 1 GB Linux VM, use the [Podman production guide](docs/podman-production.md).
It includes memory limits, persistent storage, loopback access, and boot startup.

```bash
cp .env.example .env.local
cp cliproxy/config.example.yaml cliproxy/config.yaml
# Put the same internal key in cliproxy/config.yaml and CLIPROXY_API_KEY.
docker compose --env-file .env.local pull
docker compose --env-file .env.local up -d
```

The dashboard is available at `http://localhost:8080`. Set `RAWROUTE_HOST_PORT`
and `RAWROUTE_PUBLIC_URL` to use a different host port.

Compose pulls `eceasy/cli-proxy-api:latest` from Docker Hub by default. Set `CLI_PROXY_IMAGE` in `.env.local` to use another published Docker Hub or GCR image/tag.

`Enable CLIProxy prompt cache key support` is an opt-in provider setting. It
projects CLIProxy's native `support-prompt-cache-key` option for
OpenAI-compatible providers without adding RawRoute-side cache-key or user
rewriting.

Replace all placeholder credentials before production use. The dashboard login is configured by `DEFAULT_ADMIN_USERNAME` and `DEFAULT_ADMIN_PASSWORD`.

## Wrapper behavior

Combos skip members after upstream 429, 408, or 5xx responses. Redis stores
cooldowns by workspace and resolved model, shared across gateway instances.
The gateway honors `Retry-After` and falls back to a 30-second exponential
delay capped at five minutes when no deadline is supplied. One request probes
a member when its cooldown expires; concurrent requests continue to fallback.
If every member is cooling down, the gateway returns 503 with `Retry-After`.
Budget rejections remain terminal and do not mark a provider unhealthy. If
Redis is unavailable, combos retain their original ordered fallback behavior.

For Codex combo members, a long quota cooldown can be checked early after one
minute. A fresh usage response must explicitly allow requests before RawRoute
uses CLIProxyAPI's account-specific `/v0/management/reset-quota` endpoint.
Only mapped, enabled accounts with a recorded `usage_limit_reached` error are
eligible. Checks are limited to once per account per five minutes. The next
inference request determines whether routing recovers or returns to cooldown.
This requires CLIProxyAPI support for `reset-quota`, present in v7.2.151.
Recovery runs on combo traffic, not a background timer or the dashboard.

Gateway logs label the caller as `KEY`, and failed requests include a safe
error code and retry deadline. The Codex quota view also indicates a recorded
inference quota restriction even when the usage endpoint reports availability.

The focused Redis integration test runs in CI. To run it against a test Redis
without a Next.js build, set `COMBO_TEST_REDIS_URL` and run
`bun run test src/lib/combo-circuit.test.ts --maxWorkers=1`.

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

## Local development

Install Bun 1.4.2, then run:

```bash
bun install --frozen-lockfile
bun run dev
```

The development server listens on `http://localhost:3000`. For local development,
set database and Redis URLs to services reachable from your host. Compose service
names in `.env.example` resolve only inside the Compose network.

Bun runs the application, build tools, tests, and maintenance scripts. Docker uses
the same pinned Bun version. `node:` imports use Bun's compatibility APIs and do
not require a separate Node.js installation.

## Verification

```bash
bun install --frozen-lockfile
bun run lint
bun run test
bun run typecheck
bun run build
docker compose --env-file .env.local config
```

PostgreSQL is the sole durable RawRoute data store. All workspace documents, provider/model catalogs, aliases, budgets, pricing, usage events, and rollups use the scoped canonical layout. Redis is only a disposable runtime cache for lookup, quota, and lock state; it is safe to flush after a deployment.

RawRoute does not require an external database migration at runtime. API-key ownership is indexed globally by RawRoute while every workspace resource remains under its workspace scope. Codex OAuth credentials live only in the private CLIProxyAPI backend; RawRoute stores only the workspace-to-auth-file mapping and live management metadata. CLIProxyAPI models never become RawRoute providers or catalog records.
