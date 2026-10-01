# RawRoute

RawRoute manages its private CLIProxyAPI engine directly, with optional Executor
integration. Global → CLIProxyAPI provides lifecycle, release, credential, OAuth,
and engine log management. See [managed CLIProxyAPI](docs/managed-cliproxy.md) for
setup, migration from external containers, and recovery behavior.

The original RawRoute dashboard remains intact, including workspaces, aliases, gateway keys, budgets, custom model pricing, usage analytics, Codex views, logs, and settings. RawRoute owns those wrapper features and the budget admission decision. CLIProxyAPI owns provider credentials, OAuth execution, protocol translation, retries, upstream routing, provider rate limits, and model execution.

System → Console Log follows the active workspace. Global → System Logs and
Settings are shared across workspaces and available from both gateway apps.
See [dashboard scopes and logging](docs/scopes-and-logging.md) for architecture,
retention limits, extension guidance and workspace API compatibility changes.

## Network boundary

Only RawRoute binds a host port. CLIProxyAPI runs as a managed subprocess inside
the RawRoute container, while Executor remains a separate private service for
tools, connections, integrations, and policies.

```text
client -> rawroute:8080 -> 127.0.0.1:8317 (managed CLIProxyAPI child)
                      -> executor:4788 (optional private Compose network)
                               -> provider origin
```

Managed CLIProxyAPI binds only to loopback inside the RawRoute container; its
management API is not reachable from the host. Executor uses the same private-network boundary and does not
publish port 4788. RawRoute synchronizes workspace-scoped provider projections
to CLIProxyAPI; it does not proxy or rewrite provider traffic itself.

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
# Set the required RawRoute, PostgreSQL and Redis credentials.
docker compose --env-file .env.local pull
docker compose --env-file .env.local up -d
```

Executor is optional. Set `EXECUTOR_UPSTREAM_API_KEY` to an Executor API key
and start the profile when it is needed:

```bash
docker compose --profile executor --env-file .env.local up -d
```

The public API boundary is:

- `/v1/*`, `/v1beta/*`, `/openai/v1/*`, and `/backend-api/*` belong to RawRoute and CLIProxyAPI.
- `/executor/api/*` belongs to the separate internal Executor service.
- `/api/*` and `/admin/*` remain RawRoute management routes.

Use one public base URL for Executor API calls:

```bash
curl "$PUBLIC_BASE_URL/executor/api/tools" \
  -H "Authorization: Bearer $RAWROUTE_API_KEY"
```

RawRoute authenticates the gateway key, removes client authentication and
RawRoute-only headers, then injects `Authorization: Bearer
$EXECUTOR_UPSTREAM_API_KEY` on the private hop. The upstream URL is server
configuration only; request headers and query parameters cannot select it.

This phase does not make CLIProxyAPI call Executor, does not add MCP to
RawRoute, and does not implement chat tool-calling orchestration. The public
route is API-only; Executor's browser UI and OAuth callback flow are not
exposed through `/executor`, so configure `EXECUTOR_WEB_BASE_URL` only for a
separate, deliberately configured Executor UI deployment. The current compose
deployment is single-tenant at the Executor boundary: every authenticated
RawRoute caller uses the configured Executor credential. RawRoute does not
trust incoming workspace or user headers to create Executor identity.
Executor auth and MCP endpoints are intentionally not forwarded in this phase.

The dashboard is available at `http://localhost:8080`. Set `RAWROUTE_HOST_PORT`
and `RAWROUTE_PUBLIC_URL` to use a different host port.

The RawRoute image bundles tested CLIProxyAPI `v7.3.4` from an upstream image pinned by digest. Manage later release changes from Global → CLIProxyAPI. Existing separate-container deployments remain supported through `docker-compose.external.yml`; migrate their configuration and auth files before switching to managed mode.

`Enable CLIProxy prompt cache key support` is an opt-in provider setting. It
projects CLIProxy's native `support-prompt-cache-key` option for
OpenAI-compatible providers without adding RawRoute-side cache-key or user
rewriting.

Replace all placeholder credentials before production use. The dashboard uses one shared administrator password; no username is required. `DEFAULT_ADMIN_PASSWORD` sets the initial password for a fresh installation (default: `change-me-now`). Localhost login shows the documented default while it is still active; custom initial passwords are never displayed. Set `AUTH_SHOW_DEFAULT_PASSWORD_HINT=false` to hide the hint. On first sign-in, a non-dismissible dialog requires a different private password before administration is available. Changing the environment variable does not overwrite a saved password; use the dashboard settings to change it.

Existing installations keep their current password and sessions, including those previously configured with a custom username. `DEFAULT_ADMIN_USERNAME` is no longer used.

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

The application uses native Bun full-stack React: `src/index.ts` serves the HTML
entry, bundled assets, and HTTP APIs on one port. `src/frontend.tsx` mounts React;
`src/App.tsx` owns browser routes and reuses the dashboard components. Development
uses Bun HMR and the Tailwind plugin. API registration and authorization live in
`src/server/routes.ts` and `src/server/http.ts`.

Build and run the production app locally with `bun run build` followed by
`bun run start`. The built server runs from `dist/`, where Bun resolves its
prebuilt HTML asset manifest. Docker uses the same artifact. Builds do not need
database credentials or a live backend. `bun run typecheck` checks types separately.

Bun loads local environment files for development and maintenance commands.
`TIMEZONE` configures both server and browser display; `/api/config` exposes only
the validated time zone and deployment version at runtime. Server environment
variables are never inlined into the browser bundle. `HOSTNAME` and `PORT` control
the listener; the container uses `0.0.0.0:8080`.

Page HTML is a public application shell. Session guards control dashboard
navigation, and every management API independently enforces its registered
session/workspace policy. The public analytics page fetches its data through
the public API. Unknown API and provider paths never fall back to the HTML app.

Bun runs the application, build tools, tests, and maintenance scripts. Docker uses
the same pinned Bun version. `node:` imports use Bun's compatibility APIs and do
not require a separate Node.js installation.

Browser tests run the production build with an in-memory data store and local
CLIProxy/Executor fixtures. Install Chromium with
`bunx --bun playwright install --with-deps chromium` and provide a disposable Redis
database through `E2E_REDIS_URL` (default: `redis://127.0.0.1:6379/15`).
`COMBO_TEST_REDIS_URL` enables the Redis integration test in the unit suite; use
a separate test database for it. CLIProxy lifecycle tests run on isolated ports; the
optional real-engine test is documented in the managed CLIProxyAPI guide.

Unit and integration tests use `bun:test`. Run `bun run test` (or
`bun test --isolate`) to give each file its own module registry and globals.
The test preload restores environment variables after each test. A focused run
can use `bun run test ./tests/server/http.test.ts`.

## Verification

`bun run lint` runs ESLint and React Doctor together. Both must pass without
warnings; React Doctor scans the full source tree. See
[lint documentation](docs/design-system-lint.md) for the checks and Bun runner configuration.

```bash
bun install --frozen-lockfile
bun run lint
bun run test
bun run typecheck
bun run build
bun run test:e2e
docker compose --env-file .env.local config
```

PostgreSQL is the sole durable RawRoute data store. All workspace documents, provider/model catalogs, aliases, budgets, pricing, usage events, and rollups use the scoped canonical layout. Redis is only a disposable runtime cache for lookup, quota, and lock state; it is safe to flush after a deployment.

RawRoute does not require an external database migration at runtime. API-key ownership is indexed globally by RawRoute while every workspace resource remains under its workspace scope. Codex OAuth credentials live only in the private CLIProxyAPI backend; RawRoute stores only the workspace-to-auth-file mapping and live management metadata. CLIProxyAPI models never become RawRoute providers or catalog records.
