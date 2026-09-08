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

Combos try every configured member in order on each request. RawRoute does not
skip an upstream because of a previous request's cooldown state: non-terminal
failures fall through immediately to the next member. Internal CLIProxy
cooldown responses are exposed as `503` without `Retry-After`, so coding
clients remain free to send the next request. RawRoute budget exhaustion stays
terminal and is the only locally generated long retry deadline.

Gateway logs label the caller as `KEY`, and failed requests include a safe
error code and retry deadline. The Codex quota view also indicates a recorded
inference quota restriction even when the usage endpoint reports availability.

RawRoute authenticates its gateway keys, resolves its retained aliases, applies its custom model pricing, reserves each key's RawRoute budget, and records usage. Requests that would exceed the configured budget are rejected with `429` before they reach CLIProxyAPI. The original dashboard and RawRoute-owned feature APIs remain available without exposing CLIProxyAPI management endpoints.

Model combos try each member in order for every non-terminal upstream failure.
Synthetic CLIProxy `model_cooldown` responses are returned as `503` without
`Retry-After`; only an actual RawRoute budget denial or upstream `429` retains a
rate-limit retry signal.

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
