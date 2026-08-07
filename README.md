# RawRoute

RawRoute is a small, protocol-preserving AI provider gateway. It aggregates user-configured providers and exposes prefixed model IDs without translating between API formats.

RawRoute changes only the request's `model` value, injects upstream authentication and configured headers, then streams the upstream response back without parsing or rebuilding it.

Providers, upstream API keys, and models are configured independently. A provider can own multiple enabled API keys; shared Redis routing keeps sessions sticky while distributing new work by RPM and concurrency capacity.

## Workspaces

Workspaces provide independent data scopes inside the same RawRoute deployment and Firestore database. Each workspace has its own gateway API keys, providers, provider credentials, models, aliases, usage, budgets, pricing, Codex accounts, routing state, session affinity, and console logs.

Gateway clients continue using the same API endpoints. The supplied gateway API key identifies its owning workspace, and RawRoute loads configuration and records usage only within that workspace. Gateway API-key values are globally unique across all workspaces; attempting to reuse a value returns a conflict.

The `Default` workspace always exists and cannot be renamed or deleted. Existing installations require no data migration: current Firestore data remains attached to `Default` in its legacy collections, while newly created workspaces use scoped subcollections under `<prefix>_workspaces/{workspaceId}`.

Administrators can create, switch, rename, and delete workspaces from the dashboard sidebar. New workspaces start empty. The selected admin workspace is persisted in the browser and sent to admin APIs through the `x-rawroute-workspace-id` header. The public usage dashboard also has a workspace selector and defaults to `Default`.

## Native endpoints

| Protocol | Endpoint |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` |
| Model catalog | `GET /v1/models` |
| LiteLLM model discovery | `GET /v1/model/info`, `GET /model/info` |

A request sent to the wrong protocol endpoint is rejected. RawRoute never attempts format conversion.

## Development

Requirements: Node.js 22.16.0 (managed with nvm), npm 10.9.2, access to Firestore or the Firestore emulator, and an Upstash Redis database.

```bash
nvm use
npm install
cp .env.example .env.local
npm run dev
```

The initial credentials are:

- Username: `admin`
- Password: `change-me-now`
- Gateway key: `sk-local-change-me`

The dashboard forces the admin password to be changed after the first login. Override all bootstrap credentials in production using environment variables backed by Secret Manager.

Production initialization refuses to create Firestore state when the documented defaults are used or when `SESSION_SECRET` is shorter than 32 characters.

Run checks with:

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

The Firestore smoke test is destructive only within its configured collection prefix. Always override the prefix with a dedicated value containing `integration`; never run it against the production prefix:

```bash
FIRESTORE_COLLECTION_PREFIX=rawroute_integration_smoke \
  npx tsx --env-file=.env.local scripts/firestore-smoke.ts
```

The smoke test accepts either `GOOGLE_APPLICATION_CREDENTIALS` or the inline `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` values used by the application. It verifies concurrent initialization, workspace isolation, global gateway-key uniqueness, and cleanup.

For explicit service-account authentication, set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`. Newlines in the private key may be encoded as `\n`. When these variables are absent, Cloud Run uses Application Default Credentials from the assigned service identity.

## Docker

The image contains the Next.js dashboard, backend, and streaming proxy:

```bash
docker build -t rawroute .
docker run --rm -p 8080:8080 --env-file .env.local rawroute
```

## Cloud Run

Create the Firestore database first, then deploy the single image with these settings:

```bash
gcloud run deploy rawroute \
  --source . \
  --region YOUR_REGION \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,FIRESTORE_DATABASE_ID=ai-proxy,FIRESTORE_COLLECTION_PREFIX=rawroute \
  --set-secrets DEFAULT_ADMIN_PASSWORD=rawroute-admin-password:latest,DEFAULT_PROXY_API_KEY=rawroute-proxy-key:latest,SESSION_SECRET=rawroute-session-secret:latest
```

Grant the Cloud Run service account Firestore access. `roles/datastore.user` is the usual starting point; use a narrower custom role when practical. The proxy caches its routing snapshot in each instance for `ROUTING_CACHE_TTL_MS` (30 seconds by default), avoiding a Firestore read for every inference request. Admin mutations invalidate the current process immediately; other instances observe the change after their cache expires.

Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` on every Cloud Run instance. Redis stores workspace-scoped session affinity, rolling RPM reservations, expiring concurrency leases, credential cooldowns, and Responses API ID mappings. Requests fail with `503` when shared routing state is unavailable instead of falling back to inconsistent per-instance state.

Proxy request bodies are limited by `MAX_PROXY_BODY_BYTES` (10 MiB by default), including streamed requests without a `Content-Length` header.

Routing leases renew during long requests. Streaming requests are aborted after `ROUTING_MAX_STREAM_DURATION_SECONDS` (290 seconds by default), and non-streaming requests after `ROUTING_MAX_NON_STREAM_DURATION_SECONDS` (60 seconds by default). Keep the streaming deadline below the Cloud Run request timeout so abandoned upstream work is cancelled and its lease is released before the platform terminates the request.

## Performance and cost tuning

RawRoute is designed so the proxy hot path does not reread the whole Firestore configuration. Routing snapshots, workspace status, gateway-key indexes, budget configuration, pricing, Codex quota snapshots, and assembled dashboard payloads use bounded process-local caches with single-flight loading. A warm gateway-key authentication normally performs no Firestore read; a cold lookup reads the global key index and workspace document, while an older or missing index row is self-healed. Missing rows trigger at most one bounded cross-workspace reconciliation per process cache window. Local admin mutations invalidate immediately, and other instances observe the change after the configured TTL.

Upstash Redis performs one atomic reservation and one atomic release/settlement for a normal routed request. RPM, concurrency, and cooldown keys are shared by credential across models, which both enforces the configured credential-wide limits and avoids needless key cardinality. Session affinity remains model-specific. Empty affinity/budget keys are not sent to Lua, response mappings are written only when IDs exist, and lease-renewal commands are scheduled only for requests long enough to need them. Keeping these operations atomic is intentionally favored over unsafe client-side read/modify/write sequences.

Budget admission does not rescan historical usage on every request. Each process reconciles an exact historical baseline once per budget window/configuration, then reads only the current counter document and uses Redis for concurrent reservations. Budget/window revisions are included in the Redis key, so budget edits and repricing do not continue using stale aggregates. `BUDGET_DEFAULT_OUTPUT_TOKENS`, `BUDGET_INPUT_BYTES_PER_TOKEN`, and `BUDGET_RESERVATION_SAFETY_PERCENT` tune conservative reservations for requests without a strict output cap.

Each completed request is persisted atomically as one usage event plus hourly, daily, and monthly rollups, and one budget counter update only when a budget exists. That is normally four Firestore writes, or five with an active budget. The deliberate write amplification prevents dashboard and budget pages from repeatedly scanning an ever-growing event collection. Dashboard queries merge adjacent fallback ranges, reuse boundary reads, bound Firestore fan-out, and briefly cache the finished payload. Do not remove the rollups merely to reduce writes unless the resulting unbounded read cost has been measured and accepted.

Useful controls are documented in `.env.example`. `FIRESTORE_CHILD_READ_CONCURRENCY` and `FIRESTORE_ANALYTICS_READ_CONCURRENCY` cap query fan-out; lower them when protecting a small Firestore quota or low-memory instance. `MAX_WORKSPACE_CACHE_ENTRIES` and `MAX_PROVIDER_SCOPED_CACHE_ENTRIES` bound long-lived multi-tenant caches. Higher cache TTLs generally reduce Firestore/Upstash-adjacent work but delay cross-instance visibility. Setting TTLs near zero in production can turn ordinary navigation and proxy traffic into avoidable billable reads.

Public workspace and usage responses include short shared-cache directives, while authenticated admin responses remain `no-store`. Browser SWR requests deduplicate nearby admin reads and keep previous dashboard data during refreshes; active jobs and logs retain explicit short polling intervals.

Do not mount SQLite or JSON state on a Cloud Storage bucket. Firestore is the persistent configuration source and supports multiple Cloud Run instances safely.

## Provider API keys

Provider credentials are stored as workspace-scoped records linked to their provider and are never returned to the browser after saving. Existing single-secret providers are migrated automatically into a linked API-key record. Firestore encrypts stored data at rest, but access is controlled by the Cloud Run service identity, so keep its IAM permissions narrow. A future Secret Manager-backed credential adapter can remove the credential values from the configuration document entirely.

New sessions use sticky least-loaded routing based on each key's rolling RPM and concurrency limits. Continuations reuse their pinned key when possible, while `previous_response_id` uses hard credential affinity and never silently fails over. Upstream `429` responses cool down only the affected credential. Prompt-prefix affinity is disabled by default; use an explicit `prompt_cache_key` or session identifier when stickiness is desired.

## Documentation sources

- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)
- [Next.js Route Handler streaming](https://nextjs.org/docs/app/guides/streaming)
- [shadcn Next.js installation](https://ui.shadcn.com/docs/installation/next)
- [shadcn blocks](https://ui.shadcn.com/blocks)
- [Firebase Admin server setup](https://firebase.google.com/docs/admin/setup)
- [Cloud Run service identity](https://cloud.google.com/run/docs/securing/service-identity)
- [Cloud Run secrets](https://cloud.google.com/run/docs/configuring/services/secrets)
