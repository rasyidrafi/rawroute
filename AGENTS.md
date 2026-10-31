# Coding rules

- Keep things simple; no overengineering.
- Keep user-facing UI concise and focused on the user's task. Do not render
  unnecessary information, implementation details, internal identifiers or technical
  jargon. Use clear labels and short, useful descriptions; explain only what users
  need to decide or act safely. Keep essential consequences, warnings and recovery
  actions visible, and place confirmation-specific details in confirmation dialogs.
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
- Gateway inference and Codex reset redemption use gateway-owned execution admission.
  Preserve workspace activity, deletion admission/drain, durable participant
  checkpoints/recovery and shutdown ordering, including Storage drain boundaries.
- Keep only current features/canonical routes, not compatibility aliases,
  redirects, unused pages or request-time data conversion. Persisted schema changes
  require a tested stopped-writer CLI in `scripts/migrations/`, backup and offline
  conversion before deployment. Code moves alone do not require migration.

## Verification

- Default to scoped verification, not the full suite after every task or edit.
  Select checks covering the changed behavior and its consumers, not just changed
  filenames. Aim for local feedback within 30 seconds; this is a target, never a
  timeout that truncates checks or turns incomplete verification into a pass.
- Prose-only README/AGENTS changes and non-executable comments need diff review,
  not runtime suites. Check verification-policy edits against the scripts and CI.
- For source changes, run `bun run lint` and `bun run typecheck` separately from
  build, plus relevant owner/component/server tests. Fix all source errors/warnings
  without suppressions, disabled rules or broader allowances. Architecture checks
  remain part of lint/tests. Do not run all unit tests by default.
- For browser/bundling changes, run a production build. Add focused browser tests
  when interactions/layout change; copy-only changes do not require the full browser
  suite. Verify selected tests initialize their prerequisites. Finish lint before
  Chrome starts, build once, and never rebuild `dist` while browser tests serve it.
- Keep `bun run verify` as full verification. Run
  `TMPDIR=/tmp/opencode bun run verify` without an external timeout before integration
  acceptance of security/auth, persistence/migrations, workspace isolation/deletion,
  shared contracts/UI/platform, gateway execution lifecycle, dependency/tooling changes, or
  changes whose impact cannot be bounded. Full CI checks run on pull requests before
  merge; full acceptance is not required after each local iteration.
- Distinguish this task's edits from the integration candidate. Integration scope
  includes all staged, unstaged, untracked, deleted and renamed files since the last
  verified baseline. Preserve unrelated work. Reuse passing checks only when their
  inputs and relevant dependencies are demonstrably unchanged.
- Report commands and scope, including checks omitted. A scoped pass is not full
  verification; do not claim old results cover a different source state.
- Docker copies all workspace manifests before frozen install and bundles runtime
  dependencies into `dist/`; the runner needs neither source nor workspace links.
