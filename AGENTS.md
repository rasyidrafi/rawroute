# Bun workspace modular monolith

One Bun 1.4.2 process, one SQLite connection/transaction queue, one deployment.
Bun workspaces only; no root application exports or retired `src/` tree.

- `apps/console/src/server/index.ts`: native Bun serve/start/drain/stop.
- `apps/console/src/frontend/index.html` loads `frontend.tsx` and `App.tsx`.
- `packages/{platform,gateway-ai,gateway-tools,observability}/src/` owns contracts,
  server and web implementations. `packages/ui/src/` contains neutral primitives.
- Import other owners through explicit `@rawroute/<owner>/contracts`, `/server`,
  `/web` or manifest-listed subpaths. Relative imports stay within one package.
  Tests alone may use explicit relative internal paths. Never add wildcard exports,
  mixed root barrels, source aliases, or console singleton dependencies.

The DAG is console → gateways → platform → observability/UI. Both gateways may
also use observability/UI directly; neither gateway imports the other. Platform
cannot import gateways/console. Observability and UI are neutral independent
leaves. Observability owns recording/storage/context/client/formatting; platform
owns operational-log page metadata/UI and authenticated HTTP adapters. Existing
`observability` contribution IDs, shared menus, URLs and scopes are unchanged.

API routes declare access policy in owner `server/routes.ts`; log adapters are
`platform/src/server/operational-logs/routes.ts`. Console `server/routes.ts`
statically validates and composes contributions through platform's native Bun
HTTP wrapper. Workspace handlers execute inside `runInWorkspace`; missing scope
must fail rather than silently select Default. Tools deployment/pages stay global.

Declare canonical page metadata/scope in owner `contracts/pages.ts` (platform
uses `dashboard.ts` and `operational-log-pages.ts`). Console's browser-safe
`frontend/contracts/dashboard/routes.ts` composes metadata for browser and server.
Domain links use owner metadata, not console lookup. Owner `web/module.ts`
contributes views, skeletons and navigation. Console `frontend/browser-modules.ts`
registers/validates modules BEFORE merging. `frontend/web-composition.tsx` injects
platform's `ShellComposition`: landing paths, lookup, loading/events and runtime
callbacks. Owners never import these composition roots. Browser code must not
reach server modules, environment variables, native APIs or secrets.

Workspace UI uses `useDashboardApi()` from platform web; standalone API clients
are global. Browser types/display helpers belong to owner contracts, never
server or console implementation modules. UI imports no domain packages. The
exact `@rawroute/ui` tsconfig directory marker exists only for shadcn generation;
it is NOT an exported/importable package root. Add each new primitive's explicit
subpath to `packages/ui/package.json`. Theme CSS is console `frontend/index.css`.

Console `server/composition.ts` constructs integrations explicitly, before DB
open. Console imports gateway public integration/routes/logging APIs only, never
raw stores/tables. Gateways use platform's shared persistence and durable audit;
domain schema/projection callbacks stay with their owner. Persistent authoritative
audit is separate from bounded operational logs and browser reports. Use
observability's `createRecorder` with owner event catalogs/normalizers.

CLIProxy lifecycle belongs to `packages/gateway-ai/src/server/cliproxy/`. Use its
shared connection and audited mutation boundaries; never read transport secrets
or spawn children from feature handlers. Preserve deletion admission/drain,
durable participant checkpoints/recovery, and shutdown ordering.

See `docs/architecture/005-workspaces.md` for exports, DAG and adding a gateway;
001–004 retain historical reviewed slice results. Scope/logging and managed
CLIProxy deployment guides remain in `docs/`. Consult
`.agents/skills/ask-bun/SKILL.md` and its script for Bun-specific guidance.

After changes, run `bun run lint` and fix ALL errors/warnings in source: do not
disable rules, add suppressions or broaden allowances. Architecture checking is
part of lint and unit tests. `bun run typecheck` is separate from `bun run build`.
Full acceptance: `TMPDIR=/tmp/opencode bun run verify` (no external timeout).
Docker copies every workspace manifest before frozen install, then bundles all
runtime dependencies into `dist/`; runner needs neither source nor workspace links.

Keep only current features and canonical routes. No retired URL aliases,
redirect compatibility layers, unused pages or request-time data conversion.
Persisted schema changes require a tested stopped-writer CLI under
`scripts/migrations/`, backup and offline conversion before deployment. Code
moves alone do not require a data migration. Never edit real environment/data.
