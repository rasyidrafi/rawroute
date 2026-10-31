# RawRoute

RawRoute is a self-hosted AI gateway and dashboard with workspaces, gateway keys,
budgets, model routing and usage analytics. It connects directly to configured AI
providers, with optional Executor tools and an S3 Storage Gateway. One Bun process
and SQLite database serve the application.

## Run

With Docker and Docker Compose installed:

```sh
docker compose up -d
```

Open `http://localhost:8080`. The initial administrator password is
`123456`, displayed on the login page until the required first password change.
Internal secrets and the initial AI gateway key are generated and persisted
automatically. Saved passwords and keys survive restarts. No environment file or
secret entry is needed. Set trusted origins only if your reverse proxy needs them.
Configure provider origins and credentials from the dashboard.

Older external Compose installs used the `rawroute-data` volume; the current
`docker-compose.yml` uses `rawroute-managed-data`. Do not switch Compose files
directly or the new app will start with an empty database. Before updating the old
checkout, save its exact `docker-compose.external.yml` as
`docker-compose.external.rollback.yml` beside the original `cliproxy/` directory.
Keep that file there so its relative config/auth/log/plugin paths still resolve.
Save the old environment file privately. Stop the old app, engine, and every SQLite
writer before previewing:

```sh
PROJECT="your-old-compose-project"
OLD_PROJECT_DIR="/absolute/path/to/original/compose-project" # contains cliproxy/
OLD_COMPOSE="$OLD_PROJECT_DIR/docker-compose.external.rollback.yml"
OLD_ENV="/private/path/to/saved-old.env"
NEW_IMAGE="docker.io/rasyidrafi/rawroute:latest" # use the selected upgrade image
docker compose --project-directory "$OLD_PROJECT_DIR" -p "$PROJECT" --env-file "$OLD_ENV" -f "$OLD_COMPOSE" stop rawroute cli-proxy-api
OLD_CONTAINER="$(docker compose --project-directory "$OLD_PROJECT_DIR" -p "$PROJECT" --env-file "$OLD_ENV" -f "$OLD_COMPOSE" ps -a -q rawroute)"
OLD_ENGINE="$(docker compose --project-directory "$OLD_PROJECT_DIR" -p "$PROJECT" --env-file "$OLD_ENV" -f "$OLD_COMPOSE" ps -a -q cli-proxy-api)"
docker pull "$NEW_IMAGE"
python3 scripts/deployment/migrate_external_volume.py --container "$OLD_CONTAINER" --engine-container "$OLD_ENGINE" --new-image "$NEW_IMAGE"
python3 scripts/deployment/migrate_external_volume.py --container "$OLD_CONTAINER" --engine-container "$OLD_ENGINE" --new-image "$NEW_IMAGE" --apply --writers-stopped
```

The preview reads the stopped database and credential mapping without writing to the
old volume or auth/config files. Apply copies the database and runs the bundled
credential importer against the new volume. It reads the actual auth/config bind
sources from the stopped old engine container and mounts both read-only. For the old
v8 `oauth.auth-dir: ~/.cli-proxy-api` config, the helper runs as root with
`HOME=/root` and mounts auth at `/root/.cli-proxy-api`; it does not resolve `~` using
the app image's `bun` user. Unsupported config layouts or path mismatches fail closed.
Even with no Codex accounts, the importer writes and verifies the required schema
marker. Apply keeps the old volume unchanged and tags its exact image for rollback.
It also pins the selected new image under the printed `newImageTag`, so Compose
starts the same image that performed the conversion rather than a moved `latest` tag.
Keep the old Compose file, environment, auth/config sources, volume and image until
the new deployment is verified. Start the new app only after migration reports success:

```sh
UPGRADE_IMAGE="rawroute:external-upgrade-0123456789ab" # replace with newImageTag from the apply output
RAWROUTE_IMAGE="$UPGRADE_IMAGE" docker compose -p "$PROJECT" --env-file "$OLD_ENV" -f docker-compose.yml up -d
```

If migration fails, do not start the new app. The old volume and auth/config sources
remain intact; after confirming no container uses the printed destination volume,
remove only that destination after resolving the reported cause, then retry:

```sh
DESTINATION="${PROJECT}_rawroute-managed-data"
test -z "$(docker ps -q --filter "volume=$DESTINATION")" && docker volume rm "$DESTINATION"
```

Add `-f docker-compose.storage.yml` to the new Compose command if Storage was enabled.
To roll back, stop the new deployment without
deleting volumes, then start the saved old Compose file from its original project
directory so relative auth/config/log/plugin mounts resolve as before:

```sh
docker compose -p "$PROJECT" -f docker-compose.yml down
ROLLBACK_IMAGE="rawroute:external-rollback-0123456789ab" # replace with rollbackImage from the migration output
RAWROUTE_IMAGE="$ROLLBACK_IMAGE" docker compose --project-directory "$OLD_PROJECT_DIR" -p "$PROJECT" --env-file "$OLD_ENV" -f "$OLD_COMPOSE" up -d rawroute cli-proxy-api
```

AI-only is the default. Enable Storage with one optional overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.storage.yml up -d
```

Then add an S3 connection, attach a bucket and issue a client key in **Storage
Gateway**. Storage prepares its schema and persistent encryption key automatically;
no manual migration or key generation is needed. Native runs opt in with
`STORAGE_ENABLED=true`. The overlay exposes S3 on loopback port 9000; use a TLS
proxy for remote access. Preserve the SQLite file and adjacent `.storage-key`
together in backups.

Executor is optional: configure `EXECUTOR_UPSTREAM_API_KEY` in `.env.local` and
start Compose with `--profile executor`. Its service stays private.

Run one process per database and persist `/data` in containers. Stop the writer
before taking a complete backup, including SQLite WAL files. Existing legacy usage
data requires offline conversion before upgrading;
inspect `scripts/migrations/usage-projection.ts` and its stopped-writer checks
before deployment.
Existing installations also need `scripts/migrations/request-log-groups.ts --sqlite <file>
--apply --writers-stopped` run with Bun before upgrading request logs; it creates a backup
and the workspace-scoped grouping index without inventing historical fallback links.
Rerun it when upgrading from the old request-chain index, using a fresh explicit
`--backup <new-file>`. Routing names/IDs are captured on new requests; historical
records are preserved without guessing missing snapshots.
Automatic service-tier detection requires `scripts/migrations/service-tier-pricing.ts
--sqlite <file> --catalog <models.dev-v2.json> --apply --writers-stopped --backup <new-file>`.
The v3 upgrade removes obsolete per-model tier settings while preserving pricing and
historical usage. Tiers are detected automatically using the upstream protocol. Every
model can use catalog, custom, or Standard-multiplier rates in Model Pricing; catalog
imports preserve custom tier prices. Reported tiers override requested tiers.
Existing model shares require `bun scripts/migrations/model-share-conditions.ts
--sqlite <file> --apply --writers-stopped --backup <new-file>` before upgrading to
conditional sharing. Existing grants remain unconditional.

## Develop and verify

Install Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run dev
```

Development serves `http://localhost:3000` and persists data in `data/`.
Source lives in `apps/console/` and owner packages under `packages/`.
Read source and tests for behavior; follow `AGENTS.md` for coding rules.

Use scoped checks during development: lint, separate typechecking and relevant
tests for source changes; build and focused browser tests for affected browser
flows. Prose-only edits need no runtime suites. See `AGENTS.md` for acceptance rules.

`TMPDIR=/tmp/opencode bun run verify` remains the full suite: unit/integration tests,
lint, typechecking, a production build and browser tests using installed Google
Chrome. CI runs these checks on pull requests and main code pushes; only main builds
publish images. Build/start independently with `bun run build` and `bun run start`.

Third-party attributions are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
