# Coding rules

- Keep things simple; no overengineering.
- Omakase: avoid user choices and configuration unless genuinely necessary or required.
  Implementation details use fixed owner defaults, not deployment knobs. Generate
  and persist internal secrets automatically; only external credentials and genuine
  deployment boundaries may require configuration. Fresh administrator password is
  always `123456`, shown on every login hostname until mandatory password change.
- Code and tests are the sole source of truth for behavior; read them to understand it.
  No docs folders or additional documentation files. Only `README.md` (concise
  repository overview/setup) and `AGENTS.md` (coding rules) are permitted Markdown
  filenames in owned code. Do not relocate documentation into README dumps.
- Preserve unrelated work. Never edit real environment files, credentials or data.

## Boundaries

- One Bun 1.4.2 process, one SQLite connection/serialized transaction queue, one
  deployment. Use Bun workspaces; no root application exports or retired `src/` tree.
- Owners are console, gateway-ai, gateway-tools, gateway-storage, platform,
  observability and UI. Dependency DAG: console → gateways → platform →
  observability/UI. Gateways may use the neutral leaves directly, never each other;
  platform cannot import gateways/console; UI and observability are independent.
- Import owners only through manifest-listed contracts/server/web or explicit
  subpaths. Relative imports stay within a package (tests may inspect internals).
  No wildcard exports, mixed root barrels, source aliases or console singletons.
- Console constructs integrations before opening the database and composes owner
  routes through platform's HTTP wrapper. Import gateway public integration,
  routes and logging APIs, not raw stores/tables. Owners retain schema/projections.
- Declare access policy in owner `server/routes.ts`. Workspace handlers must run
  inside `runInWorkspace`; missing scope fails, never defaults. Tools deployment
  and pages stay global. Preserve canonical URLs, contribution IDs and scopes.
- Declare page metadata/scope in owner contracts and views/navigation in owner
  `web/module.ts`. Console validates browser modules before merging and injects
  shell composition; owners never import composition roots. Links use owner metadata.
- Browser code cannot reach server modules, environment, native APIs or secrets.
  Browser types/helpers belong in owner contracts. Workspace UI uses platform's
  `useDashboardApi()`; standalone clients are global. UI imports no domain packages.
- UI primitives need explicit package subpath exports; `@rawroute/ui` is only a
  shadcn tsconfig marker, not an importable root. Theme CSS stays in console.
- Use platform shared persistence and durable audit; authoritative audit is
  separate from bounded operational logs/browser reports. Observability owns
  recording/storage/context/client/formatting; platform owns log pages and HTTP
  adapters. Use `createRecorder` with owner event catalogs/normalizers.
- CLIProxy lifecycle belongs to gateway-ai's `server/cliproxy/`. Use its shared
  connection and audited mutations; feature handlers must not read transport
  secrets or spawn children. Preserve deletion admission/drain, durable participant
  checkpoints/recovery and shutdown ordering, including Storage drain boundaries.
- Keep only current features/canonical routes, not compatibility aliases,
  redirects, unused pages or request-time data conversion. Persisted schema changes
  require a tested stopped-writer CLI in `scripts/migrations/`, backup and offline
  conversion before deployment. Code moves alone do not require migration.

## Verification

- Run `bun run lint`; fix all source errors/warnings without suppressions,
  disabled rules or broader allowances. Architecture checks are part of lint/tests.
- Run `bun run typecheck` separately from build. Full acceptance:
  `TMPDIR=/tmp/opencode bun run verify` with no external timeout.
- Docker copies all workspace manifests before frozen install and bundles runtime
  dependencies into `dist/`; the runner needs neither source nor workspace links.
