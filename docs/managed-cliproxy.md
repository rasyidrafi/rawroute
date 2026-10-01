# Managed CLIProxyAPI

Global → CLIProxyAPI controls the shared provider engine from either gateway app.
It includes service health, start/stop/restart, latest or pinned release installs,
downgrades.
Global Settings retains debug, file logging, usage statistics, and retry settings.
RawRoute retains fill-first routing to preserve workspace credential priority.

## Ownership

RawRoute owns process lifecycle, gateway authentication, workspace routing,
aliases/combos, model sharing, budgets, pricing, usage accounting, and logs.
CLIProxyAPI still owns provider execution, translation, OAuth tokens and refresh.
PostgreSQL and Redis retain their existing roles. Executor remains optional and
separate. Public gateway paths and workspace IDs do not change.

Managed CLIProxyAPI runs as a child of Bun and binds only to `127.0.0.1:8317`.
There is no Docker socket dependency. The supervisor uses Linux `/proc` to verify
PID identity and exclusive port ownership before signaling a process. Supported
release architectures are Linux amd64 and arm64. One supervisor owns a data root;
do not share that root between active RawRoute replicas.

`src/server/cliproxy/` contains lifecycle, release verification, persisted state,
process inspection, mutation coordination, migration, and global HTTP handlers.
`src/lib/cliproxy/types.ts` is the browser-safe contract. Existing gateway and
Codex clients use `connection.ts` through the shared management/transport clients.
Provider updates serialize their complete management read/modify/write operation
with lifecycle operations. The supervisor survives Bun hot reloads as a singleton.

## New deployments

The default `docker-compose.yml` runs managed mode. The application image bundles
CLIProxyAPI **7.3.4**, copied from the pinned upstream image, and seeds that release
only when there is no lifecycle state or selected binary. Fresh container boot
does not require a GitHub download. Subsequent boots honor the selected release
and whether the administrator stopped the engine. RawRoute never automatically
upgrades a running release when a newer release appears.

`RAWROUTE_DATA_DIR=/data` is persisted in `rawroute-managed-data`. It contains:

```text
cliproxy/
  config.yaml
  auth/
  secrets/api-key
  secrets/management-key
  versions/<version>/cli-proxy-api
  current -> versions/<version>
  state.json
  logs/
```

RawRoute generates private management and transport credentials. These credentials are internal; the dashboard and public admin API do not expose engine key management. Engine credentials
are separate from public workspace gateway keys.

For source development, set `CLIPROXY_MODE=managed` and optionally
`RAWROUTE_DATA_DIR`. A fresh source checkout has no bundled binary: sign in,
change the initial password, and install a release from the global page.

For Podman, `deploy/podman/rawroute-managed.container` is the managed alternative
to `rawroute.container` plus `rawroute-cliproxy.container`. Install it as your
RawRoute unit, together with `rawroute-managed-data.volume`; do not run both
variants with the same container name. Its 448 MB memory limit includes both Bun
and Go; the original external units remain available. Revisit limits for larger
provider catalogs or concurrent traffic.

## Existing installations: preserve data before switching

Existing Compose deployments can continue using:

```sh
docker compose -f docker-compose.external.yml --env-file .env.local up -d
```

This retains the original CLIProxy image/config/auth/log/plugin mounts and sets
`CLIPROXY_MODE=external`. Lifecycle buttons are unavailable in external mode;
engine configuration belongs to the external deployment. Existing
environments without `CLIPROXY_MODE` remain external when any `CLIPROXY_URL`,
`CLIPROXY_API_KEY`, or `CLIPROXY_MANAGEMENT_KEY` is configured.

To migrate, stop RawRoute and its old CLIProxy service, back up the database and
the complete CLIProxy data, then import into an unused managed data directory.
Do not delete the old files or database. The import source must contain:

```text
legacy/
  config.yaml
  auths/          # complete old auth volume, with original file names
  logs/           # optional old engine logs
  plugins/        # optional old plugin data
```

For a source installation where the paths also exist at runtime:

```sh
bun scripts/import-cliproxy.ts /absolute/legacy /absolute/new-data
```

The image includes `/app/dist/import-cliproxy.js`. Run it against the volume that
will later be mounted at `/data`, using the same runtime path during import:

```sh
docker run --rm --user root --entrypoint sh \
  -v /absolute/legacy:/legacy:ro \
  -v rawroute-managed-data:/data \
  YOUR_NEW_RAWROUTE_IMAGE -c 'bun /app/dist/import-cliproxy.js /legacy /data && chown -R bun:bun /data'
```

Use your deployment's actual volume name (Compose normally prefixes it with the
project name). If attaching an existing volume, ensure `/data` is writable by the
image's `bun` user. The one-off importer runs as container root to read private
legacy files, then assigns the new volume to `bun`; the application still runs
as `bun`. The importer refuses an existing `cliproxy/` target and stages
the complete import before publishing it. It preserves source files, auth names,
credential contents, prefixes, priorities, original API keys, custom config, logs,
and plugin files. It replaces only the listener, auth directory and private
management credential, and adds RawRoute's protected transport key. Check custom
absolute paths, external certificates and plugin dependencies against the new
container; those external resources must also be mounted in the new deployment.

Start RawRoute in managed mode with that data volume and the **same PostgreSQL,
Redis and RawRoute encryption/session configuration**. Workspace mappings remain
in PostgreSQL; live auth indexes are read again from CLIProxy. Verify accounts,
models and representative requests before retiring the old container. There is
no RawRoute database schema migration for this port.

## Operations and recovery

Lifecycle mutations require an authenticated administrator who has changed the
initial password, plus an exact matching Origin. Set `RAWROUTE_PUBLIC_URL` to the
browser-facing origin behind a reverse proxy. Global APIs ignore workspace
headers. Public CLIProxy management endpoints remain unexposed.

Stop/restart/install closes admission to new engine requests and waits up to
30 seconds for existing requests, streams, and their usage settlement. If that
deadline expires, the operation fails and the running service is retained; retry
after the requests finish. Finish or cancel a pending Codex login before changing
the service. A single-engine deployment can have an availability gap during
restart or release replacement. Native Responses execution and Executor retain
their separate execution paths.

Release downloads are constrained to upstream GitHub release assets, verified
against SHA-256 checksums, staged, and activated with an atomic symlink switch.
After stopping the child, updates snapshot configuration and auth files. Startup
failure or an interrupted update restores the previous binary, pin, desired state,
configuration and credential snapshot. Plugin data is preserved but is not part
of the update rollback snapshot. Keep backups before changing across releases
with incompatible upstream data formats.

Unexpected exits trigger up to five automatic restart attempts with backoff.
Provider configuration is reconciled after startup/recovery. System Logs records
lifecycle events with source `cliproxy`; request and accounting events retain
their workspace scope. Engine logs remain instance-wide and are redacted before
display. CLIProxy file logging must be enabled to read its file log endpoint.

`/api/live` reports RawRoute process availability and is used by the managed
container healthcheck, so an intentionally stopped engine does not make the
management UI unhealthy. `/api/health` retains dependency readiness checks and
returns 503 when CLIProxy, PostgreSQL, or Redis is unavailable.

OAuth connections are supported only for Codex inside a workspace. Connect accounts
from that workspace’s Codex Providers page. Account visibility and management
remain scoped to the owning workspace.

## Validation

Run `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`, and the
Playwright suite. Lifecycle tests use compiled fixtures on isolated ephemeral
ports and temporary data, including crashes, locks, update rollback and recovery.
To exercise the real tested engine without provider credentials:

```sh
CLIPROXY_INTEGRATION_BINARY=/absolute/cli-proxy-api bun run test tests/server/cliproxy.integration.test.ts
```

This test uses an isolated listener, temporary data and a local fake provider.
It exercises authenticated inference, persisted projections, stop/start and
restart against CLIProxyAPI 7.3.4. Real provider OAuth still requires that
provider's interactive authorization and network access.

## Internal engine defaults

Managed instances default to debug off, file logging on with a 100 MB total log cleanup target, usage statistics on, zero additional retry rounds, zero cooldown wait, and fill-first routing. No dashboard page or admin API exposes these settings.

For existing installations, stop RawRoute and run `bun scripts/configure-cliproxy-defaults.ts --config=/path/to/cliproxy/config.yaml --apply`. This offline conversion backs up the original config and preserves credentials and provider configuration. Omit `--apply` for a dry run.
