# Static browser ownership (in-tree extraction)

> Historical slice record. Physical workspace extraction is now complete.
> Current package ownership, exports, DAG and extension instructions are in
> [005-workspaces.md](005-workspaces.md). Deferrals and verification numbers
> below describe that earlier slice, not the current implementation. Paths are
> updated where there is a direct equivalent.

One Bun executable and deployment remain. This slice establishes owner paths and
browser/server boundaries before physical workspace/package exports. No manifests,
Docker wiring, schema conversion, retired URLs, compatibility modules, algorithms,
styles or product features are introduced. Work remains uncommitted for review.

## Owner contributions

Each owner's `web/module.ts` exports a static browser module through its separate
`web/index.ts` entrypoint. Contracts have independent browser-safe entrypoints;
server integrations remain separate. No browser entrypoint exports server code.

| Owner | Contracts | Web implementation |
| --- | --- | --- |
| Platform | `platform/contracts/{dashboard,browser-module,workspace,request-identity,http}.ts` | Shell/sidebar/header, auth/login/settings, session/password/theme, API/workspace/SWR contexts, shell loading |
| AI | `gateways/ai/contracts/` | All AI views/hooks/components, public dashboard/key usage, CLIProxy global UI, navigation and workspace-change policy |
| Tools | `gateways/tools/contracts/` | Six global Executor pages, status hook and availability contribution |
| Observability | `observability/contracts/` | Workspace/global log views/skeletons, bounded browser reporting, formatting and polling/cancellation |
| UI | No domain contracts | Primitives, loading surfaces, resource feedback, layout, mobile hook, class/navigation helpers under `ui/` |

Canonical dashboard metadata is declared once in each owner's contracts. Console
`lib/dashboard/routes.ts` explicitly composes metadata for server HTML routes,
page/scope validation and browser lookup; parameter matching derives from those
patterns. AI link helpers substitute encoded parameters into its own patterns.
Ownership, access scope and navigation placement are independent: CLIProxy is AI
owned, globally scoped and shared navigation; logs are observability owned with
workspace/global scopes. Every Tools runtime page stays global.

`browser-modules.ts` registers the four concrete modules. Validation runs BEFORE
merging and rejects duplicate page IDs/paths (including parameter-equivalent
routes), owner/app/path/scope mistakes, missing/extra views and skeletons, dangling
or inconsistent navigation, invalid app landing ownership, duplicate module/app
IDs and collisions in public routes. There is no discovery, plugin registry or
cross-domain module lookup singleton.

## Neutral platform shell and console adapters

`platform/web/shell-composition.tsx` owns the required React context. Console
`web-composition.tsx` supplies apps, page lookup, default landing, skeleton
renderer, final browser-event slot/reporting and workspace-change behavior.
Platform never imports AI, Tools or console, directly or transitively.

The AI workspace callback preserves provider-detail → provider-list navigation
when switching workspaces. Console supplies the Tools availability wrapper inside
the authenticated shell's ORIGINAL global API/SWR cache boundary, not on login
or public routes. App switch disabling/status labels, history state, localStorage
selection, workspace cache resets and retained drafts remain unchanged. Login
receives its dashboard landing from console; the intentional session redirects
remain. Public usage keeps its original explicit Default workspace and budget
window defaults. Owner public views and skeletons are registered by AI.

`App.tsx` composes routing/session gates/public contributions. `frontend.tsx`
bootstraps theme/tooltips/toasts. `route-skeleton.tsx` selects the registered owner
loading contribution; platform loading only calls its injected renderer.
`dashboard-events.tsx` composes final navigation/error attribution. Observability
server ingestion still receives console's browser page/scope validator by the
existing explicit server integration injection.

Actual views/skeletons moved unchanged to owners. The original eager lightweight
Overview/Request Logs/integration surfaces and lazy feature/public chunks remain;
there is no eager export of lazy view implementations through a mixed root.
UI's toast surface takes a theme prop; platform adapts its theme context. The
ESLint shadcn exemptions name exactly the relocated original primitive files,
NOT the newly colocated loading/resource helpers.

## Contracts and server-only implementation

The retired `lib/types.ts` is now AI's `contracts/domain.ts`, containing AI
models/credentials/routing, pricing/budget/usage and display shapes; platform's
existing workspace/identity contracts remain independent. Codex quota/discovery
and request-log display types were extracted from server modules into AI
contracts. Pure reasoning/provider capabilities, overview/catalog metadata,
usage display and dashboard defaults are AI browser-safe contracts.

All remaining production AI analytics/pricing/models-dev/Codex/gateway/transport/
usage/sharing/request helpers moved from `lib` to `gateways/ai/server/` without
algorithm changes. `model-identifiers.ts` replaces the misleading AI `lib/http.ts`
path. No compatibility reexports remain at retired source paths. Some historical
unit tests remain under `src/lib`; they import canonical owner implementations.

Neutral date arithmetic/formatting is `shared/timezone.ts`. The separate platform
server adapter installs dynamic deployment TIMEZONE lookup. The browser graph has
no process/environment access, while offline/server timezone behavior is retained.

## Resolved graph enforcement

`tests/server/platform-dependencies.test.ts` scans ALL production owner web and
contracts files, all primitives, the actual `frontend.tsx` transitive graph and
all server branches. It resolves aliases, relative imports, reexports, static
dynamic imports and import-types. Browser graphs reject server modules, Bun/node
imports, unapproved runtime dependencies and server-only globals/environment
access. Server graphs reject console/web/cross-gateway dependencies. Negative
fixtures exercise direct/indirect/type/dynamic/export leaks and primitive-to-
domain backdoors. There are no excluded production feature files.

## Historical planned physical move map (completed in 005)

- `platform/{contracts,server,web}` → platform's separate corresponding exports.
- `gateways/ai/{contracts,server,web}` → gateway-ai's corresponding exports.
- `gateways/tools/{contracts,server,web}` → gateway-tools's corresponding exports.
- `observability/{contracts,server,web}` → observability's corresponding exports.
- `ui/` → domain-independent UI package subpaths.
- `shared/` → neutral platform infrastructure/browser leaves, with server-only
  cache/audit-context entrypoints kept distinct from timezone/auth-default leaves.
- Console-only roots: `App.tsx`, `frontend.tsx`, `browser-modules.ts`,
  `web-composition.tsx`, `route-skeleton.tsx`, `dashboard-events.tsx`,
  `lib/dashboard/{routes,validate,validate-browser}.ts`,
  `lib/logging/browser-events.ts`, `index.ts` and `server/**`.

At this slice `components.json` pointed to in-tree `ui/` aliases. Physical package
imports/exports, build/deployment paths and manifests, plus repeated Docker
acceptance, are now completed in 005. The results below remain this earlier slice's.

## Verification

Final `TMPDIR=/tmp/opencode bun run verify` (timeout 0) passed all five checks:
**622 unit tests passed / 1 skipped / 0 failed**, lint including React Doctor with
no warnings, typecheck, production build, and **all 93 Chrome E2E tests**.
Full log: `/tmp/opencode/rawroute-frontend-ownership-complete-verify-final.log`;
per-check logs: `/tmp/opencode/rawroute-verify-m5we3B/`. An earlier complete
post-extraction run also passed at `/tmp/opencode/rawroute-verify-7cVpyY/`.
The preceding run's only failing unit fixture was updated to explicitly install
the server timezone adapter; all 93 browsers passed in that run too.
