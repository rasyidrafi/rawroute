# RawRoute

RawRoute is a self-hosted AI gateway and dashboard with workspaces, gateway keys,
budgets, model routing and usage analytics. It manages a private CLIProxyAPI engine,
with optional Executor tools and a native S3 Storage Gateway. One Bun process and
SQLite database serve the application.

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
CLIProxyAPI remains private; configure providers from the dashboard. Container
images include a tested engine; native development can install it from
**Global → CLIProxyAPI**.

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
before taking a complete backup, including SQLite WAL files and managed engine
state. Existing legacy usage data requires offline conversion before upgrading;
inspect `scripts/migrations/usage-projection.ts` and its stopped-writer checks
before deployment.

## Develop and verify

Install Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run dev
```

Development serves `http://localhost:3000` and persists data in `data/`.
Source lives in `apps/console/` and owner packages under `packages/`.
Read source and tests for behavior; follow `AGENTS.md` for coding rules.

```sh
bun run lint
bun run typecheck
TMPDIR=/tmp/opencode bun run verify
```

Full verification includes unit/integration tests, lint, typechecking, a production
build and browser tests using installed Google Chrome. Build/start independently
with `bun run build` and `bun run start`.

Third-party attributions are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
