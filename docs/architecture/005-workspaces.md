# Physical Bun workspaces and extension guide

Status: implementation verified and independent review passed; work remains uncommitted. This is the final
physical extraction, not a package skeleton or another deployment topology.
Earlier slices and their historical test counts are recorded in 001–004.

## Layout and dependency DAG

```text
apps/console/src/{frontend,server}        executable/static composition
packages/platform/src/{contracts,server,web}
packages/gateway-ai/src/{contracts,server,web}
packages/gateway-tools/src/{contracts,server,web}
packages/observability/src/{contracts,server,web}
packages/ui/src                          neutral React primitives/helpers
scripts/migrations                      stopped-writer conversion CLIs
tests/{server,components,unit,e2e,diagnostics}
```

```text
console ──→ gateway-ai ──┬─→ platform ──┬─→ observability
        └─→ gateway-tools┘             └─→ ui
```

Console and both gateways also directly depend on the leaves they actually use.
There is **no edge between gateways**, no reverse dependency on console, and no
edge between observability and UI. Each package declares every external runtime
dependency it imports. Root dependencies are development/tooling only, including
workspace dependencies for offline scripts. No Nx, Turbo, discovery or plugin
container is involved. A new gateway is a package/module, not another service.

To avoid a platform↔observability cycle, platform owns operational-log page
metadata, views/navigation/skeletons and authorization/workspace HTTP adapters:
`packages/platform/src/{contracts/operational-log-pages.ts,web/operational-logs,
server/operational-logs}`. Their stable contribution owner/ID remains
`observability`; `/dashboard/logs`, `/dashboard/system-logs` and the three API
URLs, menu placement and workspace/global scopes are unchanged. Neutral
observability owns bounded log storage/admissions, correlation, redaction,
recorders, browser reporting and formatting. Injected workspace lookup/admission
and page validation remain explicit, not hidden singleton imports.

Shared facilities now have real owners:

- Platform contracts: authentication defaults and bootstrap status.
- Platform server: concurrency, bounded local cache, SQLite, workspace admission,
  task tracking, lifecycle, identity/session and durable audit.
- Observability server: neutral async audit identity/correlation context (not
  persistent audit), operational recording/storage/request context.
- Observability contracts: runtime-neutral HTTP errors and timezone arithmetic.
  Platform's separate server timezone adapter installs dynamic deployment
  `TIMEZONE` lookup. Browser formatting retains native zone and DST behavior.
- UI: only domain-independent primitives, loading/layout/resource feedback,
  class/navigation helpers. Toast theme is passed in, not imported from platform.

## Public entrypoints

There is no `@rawroute/<package>` mixed root export. Package manifests are the
complete, explicit API inventory; no `./* → ./src/*` wildcard is permitted.

| Package | Stable surfaces |
| --- | --- |
| platform | `/contracts`, `/server` (configured platform runtime), `/web` (shell/module/context) |
| gateway-ai | `/contracts`, `/server` (`aiServer`, verified authentication capability), `/web` (module + workspace callback) |
| gateway-tools | `/contracts`, `/server` (configure/forward integration), `/web` (module + availability) |
| observability | `/contracts`, `/server` (recorder), `/web` (bounded client/formatting) |
| ui | Individual named primitives/helpers: `/button`, `/utils`, `/page-layout`, etc.; no root barrel |

Narrow subpaths expose actual shared facilities: platform `/server/database`,
`/server/workspace-context`, `/server/workspace-activity`, `/server/background-tasks`,
`/server/audit`, `/server/timezone`, `/server/local-cache`, `/server/concurrency`,
identity/runtime/HTTP/routes; platform contracts and selected shell web helpers;
observability `/server/{request-context,audit-context,store,http,recorder}`,
`/contracts/{types,browser-events,http,timezone}`, `/web/{client,format}`.
Gateway `/server/routes` and Tools `/server/logging` are explicit console-facing
contributions. Existing `/server/integration` names reference the same integration
entrypoints; they do not expose a repository. Browser contracts never import a
server barrel, and lazy feature views are not eagerly re-exported.

AI additionally exports **offline-only** `/server/maintenance/{usage-projection,
cliproxy,identifiers}` for the real stopped-writer tools. These are not console
runtime APIs: the checker rejects console imports of them. Raw stores, tables,
transport secrets and internal repositories are private. Tests/diagnostic fixtures
may import private files through explicit relative paths; no test-only file is
published through exports. Diagnostic commands now live in `tests/diagnostics/`.

## Enforcement and tooling

`bun run check:architecture` reads actual workspace manifests and resolves source
imports/re-exports/import-types/static dynamic imports and HTML/CSS entry links.
It checks declared dependencies, acyclic/wrong-direction edges, exact exports,
relative/alias bypasses, private/root imports and server/browser layer direction.
Every production owner file, the real HTML/frontend graph, all web/contracts/UI
roots, and production/offline scripts are scanned. Browser traversal rejects
server/native modules, server globals/secrets and unapproved runtime dependencies.
Server traversal cannot reach React views via metadata; native Bun HTML imports
are explicit browser entry boundaries. Negative fixtures exercise these checks,
including transitive helpers, relative/type/dynamic/export leaks, wildcard/mixed
root exports and undeclared dependencies. Lint, unit tests and CI run the guard.
Build also validates Bun's actual metafile: HTML entry outputs, all reachable
lazy/shared chunks, their contributing source files and emitted runtime edges.
Server/private source or unbundled/native dependencies in that browser output
graph fail the build; tree-shaken input-only library reexports are not mistaken
for shipped runtime imports.

Production imports use package exports, never cross-package `/src/` paths. Internal
relative imports are fine. No old `@/` alias or root `src/` compatibility remains.
The single exact tsconfig `@rawroute/ui` directory marker lets shadcn resolve the
generation destination; a production bare-root import still fails export checks.
`components.json` targets `packages/ui/src` and console CSS; add a new primitive's
exact export when installing it. React Doctor discovers/scans all five React
workspaces. ESLint keeps only the original, explicitly named primitive styling
exceptions; domain/loading helpers have no new exemptions.

Bun 1.4.2 is pinned. From root: frozen install, `bun run dev`, `bun run lint`,
`bun run typecheck`, `TMPDIR=/tmp/opencode bun run verify`. Native Bun routes,
HTML/Tailwind bundling and `env: "disable"` remain. Build produces `dist/index.js`,
hashed browser assets and bundled offline entrypoints. Tailwind explicitly scans
workspace sources. Production starts with `bun run start` as before.

Docker copies the root lockfile and **all six workspace manifests before frozen
install**, then copies sources and typechecks/bundles. Runtime contains bundled
`dist/`, Bun and pinned CLIProxyAPI 7.3.4, no workspace links or source imports.
Managed CLIProxy is still the nonroot server's loopback child. Existing managed
and external Compose/Podman modes do not add storage sidecars or host ports.
Offline runtime CLIs are `dist/import-cliproxy.js`,
`dist/migrations/{usage-projection,aliases-to-combos}.js` and
`dist/predict-missing-usage-cost.js`; use the existing stopped-writer/backup
instructions. This code move changes no persisted schema and needs no new data
migration. Preserve a matched DB backup/image for rollback.

## Add a gateway (without editing AI business logic)

This is an explicit extension checklist, not a shipped placeholder gateway.

1. Create `packages/gateway-<name>/package.json` with a private workspace name,
   explicit `/contracts`, `/server`, `/server/routes`, `/web` exports and only its
   actual dependencies (normally platform, UI and neutral observability). No
   dependency on AI, Tools or console. Add its workspace dependency to console
   and the root tooling manifest; regenerate/freeze `bun.lock`. Add its direction
   to the architecture checker's closed DAG and copy its manifest in Docker.
2. Add the stable owner/app identifiers to platform's browser-safe dashboard
   contract unions. In the new owner's `contracts/pages.ts`, declare unique page
   IDs with canonical `/dashboard/<name>/…` paths, title, owner, scope, app and
   skeleton. Example shape: `{ path: "/dashboard/<name>/overview", title:
   "Overview", owner: "<name>", app: "<name>-gateway", scope: "workspace",
   skeleton: "<name>-overview" }`. Derive links with `pagePathsFor`, never by
   importing console's final registry. Scope is a deliberate domain decision,
   not inferred from path/navigation. Existing Tools pages/deployment stay global.
3. Implement owner `web/{navigation,views,skeletons,module}.tsx/ts`. A module is a
   plain contribution satisfying platform's `BrowserModule`: `{ owner, pages,
   views, skeletons, app }`, optionally shared navigation/public routes. Use
   `lazy(() => import("./feature"))` for feature views and supply matching loading
   geometry. Workspace views use `useDashboardApi()` inside the platform shell;
   global APIs use global clients. No server imports or console singletons.
4. Make the small **explicit console browser edits**: register the module in
   `frontend/browser-modules.ts`; register its metadata in
   `frontend/contracts/dashboard/routes.ts` and merge its pages; extend the
   closed owner→app/path validation in `validate.ts`. Add any intentional public
   route metadata to `isPagePath` recognition, not aliases. Supply optional
   availability/workspace callbacks via `frontend/web-composition.tsx`, composing
   owner capabilities rather than reverse imports. Existing validation must
   reject collisions/missing views/skeletons/navigation before merging.
5. Declare owner server routes using platform's `declareRoute`, e.g.
   `declareRoute({ GET: handler }, "workspace", "/api/admin/<name>/items")`.
   `session` is global session administration; `workspace`/`explicit-workspace`
   require a valid explicit header and run inside workspace admission; `gateway`
   gets identity from verified credentials, never a dashboard header. Public
   routes must be intentional. Set streaming/draining timeout policy at the
   owner declaration. Add the contribution once to console `server/routes.ts`.
6. Export an integration capability from owner `/server`, similar in shape to
   `{ initializePersistence, start, stop, health, deletionParticipant? }` only
   where needed. Configure it explicitly in console `server/composition.ts`.
   Register persistence/projection/security callbacks before database open; add
   start/recovery/health/stop calls in console server lifecycle. Use the same
   platform DB and transaction queue, not a second connection. A deletion
   participant must have a stable ID, be idempotent, and preserve retry ownership
   until remote cleanup succeeds. Do not add a participant for resources the
   gateway does not own. Track background/stream work so deletion/shutdown drain.
7. Keep schema/projection versions, migration validation and sensitive-document
   audit catalogs domain-owned. If persisted shape changes, add a tested offline
   CLI in `scripts/migrations/`, dry-run/backup/stop writers/convert before deploy;
   never convert on requests. Record authoritative local mutations atomically
   through platform audit on the same transaction. Remote side effects require
   durable intent and redacted outcome, not claims of distributed atomicity.
   Operational logs use an owner closed catalog + `createRecorder`; browser
   reports are never authoritative audit.
8. Test metadata/route collisions and access gates, missing scope, two-workspace
   isolation, lifecycle/restart/drain/deletion retries, audit rollback/redaction,
   contract/browser boundaries and lazy UI/loading/navigation. Add browser flows,
   run frozen install/lint/typecheck/full units/build/E2E, then Docker build and a
   disposable isolated managed runtime smoke. Update this guide and registrations.

Companion services (Executor or future private engines) expose private HTTP APIs
and browser-safe contracts. They do not import console singletons or share the
SQLite file across processes. A gateway integration owns its companion transport,
credentials and lifecycle capability. Physical packages do not turn RawRoute into
microservices: one process remains the physical SQLite owner; no empty sidecar,
generic gateway framework or new Storage Gateway is introduced.

## Final verification

Pinned Bun 1.4.2 final `TMPDIR=/tmp/opencode bun run verify` passed all five checks:
**618 unit tests passed / 1 optional real-engine skip / 0 failed**, lint with no
warnings (all five React workspaces), typecheck, production build and **all 93
Chrome E2E tests**. Counts differ from the 622-test prior slice because nine
in-tree graph tests were consolidated into five package/output-graph tests with
expanded negative fixtures; no business regression tests were removed. Build
validated 66 actual browser chunks / 1,260 contributing inputs; the source guard
validated six workspaces / 374 production files / 202 browser-reachable files.

A real **no-cache Docker build**, including clean frozen install and pinned
CLIProxyAPI 7.3.4 extraction, passed. The exact image then passed an isolated
nonroot runtime smoke (`--network none`, no host ports, disposable executable
tmpfs `/data`): startup/health, login/password gate/rotation, workspace creation,
managed engine running/healthy at 7.3.4, and six redacted SQLite audit records
surviving operational-log clearing. Bundled usage/alias migration dry runs passed
against an offline snapshot. Container and tmpfs were removed afterward.

Both Compose modes validated with explicit TEST sample environment, with and
without the optional Executor profile. Podman/Podman Compose are not installed,
so no native Podman syntax/runtime result is claimed. Canonical disposable SQLite
diagnostics and the 100-event/one-trial offline benchmark also passed. Shadcn
`info --json` resolves UI and CSS to the correct workspace locations.

Evidence under `/tmp/opencode/`: `rawroute-monorepo-verify-pinned-final.log`
(per-check directory `rawroute-verify-Ox7lSd/`),
`rawroute-monorepo-docker-build-clean-final.log`,
`rawroute-monorepo-image-smoke-clean-final.log`,
`rawroute-monorepo-{local-db,perf}-smoke.log`, and Compose/shadcn logs.
The full export inventory and handoff are
`rawroute-monorepo-public-api.json` and `rawroute-monorepo-handoff.md`.
Historical counts in 001–004 are not final-slice results. Independent monorepo
review passed with no fixes or gaps; the parent also checked the final verification,
actual Docker smoke and active deployment/offline references. No new schema
migration, real environment/data edit or live deployment change is claimed.
