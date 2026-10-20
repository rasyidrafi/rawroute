# Static server ownership (in-tree extraction)

> Historical slice record. Physical workspace extraction is now complete.
> Current package ownership, exports, DAG and extension instructions are in
> [005-workspaces.md](005-workspaces.md). Deferrals and verification numbers
> below describe that earlier slice, not the current implementation. Paths are
> updated where there is a direct equivalent.

The subsequent [browser ownership slice](004-browser-composition.md) supersedes
the frontend/mixed-lib deferrals below and documents the current canonical owner
paths. This document retains the reviewed server-slice history.

Status: implemented, uncommitted pending independent review. This is the server
ownership slice, **not** the physical Bun workspace or frontend extraction slice.
One Bun process, one SQLite connection/async transaction queue and one deployment
remain. There is no schema change, data conversion, registry framework, Storage
Gateway, retired URL or handler compatibility module.

## Static production wiring

`apps/console/src/server/composition.ts` constructs the concrete integrations before requests
can run. `apps/console/src/server/routes.ts` explicitly imports four owner contributions and
adds only `/api/live` and composite `/api/health`. Each canonical path occurs once
in its owner's declaration, not as a second object key. Contributions are passed
through `validateServerRoutes` and `apps/console/src/server/route-composition.ts` to the native
Bun wrapper in `packages/platform/src/server/http.ts`. Method/HEAD/OPTIONS, password gates,
scope, correlation, audit identity, idle timeouts and cache behavior are unchanged.

| Owner | Server contribution | Ownership |
| --- | --- | --- |
| Platform | `packages/platform/src/server/routes.ts` (10 routes) | Auth/bootstrap/session, account/password, workspace administration/public listing, deployment version |
| AI | `packages/gateway-ai/src/server/routes.ts` (52 routes) | Providers/credentials/models/shares/combos, keys/budgets/pricing/usage/request logs/overview, public dashboard/usage/catalog, inference, OAuth callbacks, global CLIProxy |
| Tools | `packages/gateway-tools/src/server/routes.ts` (3 routes) | Global status and shared Executor API transport |
| Observability | `packages/platform/src/server/operational-logs/routes.ts` (3 routes) | Workspace/global operational log snapshots/clearing and browser ingestion |

Actual handlers are beneath those owners' `server/routes/` folders. The only
remaining console handler folder is composite health. Old handler modules and
console identity/workspace/Tools adapter modules were removed; callers and tests
use the new canonical paths.

## Historical public integration surfaces (now package exports in 005)

- **Platform:** `server/runtime.ts` exports `createPlatformServer(dependencies)`
  and `configurePlatformServer(dependencies)` plus configured identity/session/
  workspace operations. The pure factory has independent identity memory by
  default; production configuration retains process identity memory across HMR.
  Unconfigured use fails explicitly. Dependencies are identity bootstrap/change
  hooks and ordered, stable workspace cleanup participants. Domain handlers use
  these platform-owned services, never console instances. `server/identity.ts`,
  `session.ts`, `workspace-repository.ts`, `workspace-activity.ts`,
  `workspace-context.ts`, `background-tasks.ts` and `database.ts` expose the
  corresponding factories/primitives. Generic HTTP/error helpers contain no AI
  formatting or mixed AI core types.
- **AI:** `server/integration.ts` exports `aiServer`: `initializePersistence`,
  atomic identity hooks, `deletionParticipant`, `assertBootstrap`, `start`, `stop`
  and `health`. `authenticateGatewayIdentity(request)` verifies the same existing
  AI key and active owning workspace, then returns only the verified platform
  identity contract. Console never imports the AI store, projection adapter,
  usage tables or mutable repository internals. AI owns the store, persistence
  contribution, bootstrap key writes, cleanup implementation, signing handling,
  authentication implementation, event metadata and CLIProxy secrets/lifecycle.
  `server/signing.ts` consumes only platform's signing capability; key material
  is never copied into routing snapshots.
- **Tools:** `server/integration.ts` exports `configureToolsServer(dependencies)`
  and `proxyExecutorRequest`. Its actual runtime is `server/runtime.ts`; the
  executable injects `authenticateGatewayIdentity` and the Tools-owned recorder.
  Tools imports no AI code, even transitively. The existing keys, owner scope,
  global upstream and credential/header forwarding rules are unchanged.
- **Observability:** `server/integration.ts` exports
  `configureObservabilityServer({ getWorkspace, runInWorkspace,
  browserEventScope })`. Browser ingestion uses these actual injected operations,
  not unused factories. `server/recorder.ts` exports
  `createRecorder(catalog, normalizeDetails)` and the neutral recorder;
  `server/store.ts` owns bounded scoped admissions/storage;
  `server/request-context.ts` owns generic correlation/log scope. AI and Tools
  explicitly construct recorders with their own `server/events.ts` catalogs. AI's
  normalizer retains the reviewed reasoning/tool/usage fields and redaction.
  Observability imports only neutral helpers and browser-safe platform contracts,
  never platform domain implementations, gateways, console or dashboard metadata.
- **Contracts/neutral leaves:** `platform/contracts/{http,workspace,
  request-identity}.ts`, `gateways/tools/contracts.ts`,
  `observability/contracts/{types,browser-events}.ts` and `neutral exported facilities (see architecture/005-workspaces.md)/` are public
  neutral foundations. Shared leaves include HTTP formatting, concurrency,
  in-process cache, authentication defaults and async audit identity propagation.
  Durable audit storage/catalog decisions remain platform-owned; AI contributes
  its concrete security document catalog beside its projection callbacks.

These are concrete static imports/callbacks, not module discovery or a plugin
container. Console bridges AI verification to Tools explicitly. Platform has no
gateway-dependent import exceptions; its neutral infrastructure dependencies
cannot bring gateways back transitively.

## Lifecycle and persistence guarantees

Composition installs AI callbacks before database open. The identity hooks still
create metadata and indexed bootstrap credentials on the same transaction.
Projection/audit exceptions roll back documents, indices and projections together.
AI never receives a second database or transaction queue.

Startup starts/reconciles the shared AI engine before resuming deletion journals.
Participants remain `ai`, then `operational-logs`; platform finalizes only after
both checkpoint successfully. Tools has no deletion participant or remote delete.
Shutdown drains HTTP, tracked accounting/jobs and deletion coordinators before
stopping AI/CLIProxy and closing database/cache. Workspace activity, deletion
inflight coordinators, identity memory, request scope and tracked job/task sets
retain process ownership across compatible hot reloads. Existing CLIProxy
supervisor and signal-handler replacement behavior are retained.

## Regression checks and remaining scope

`tests/server/platform-dependencies.test.ts` resolves imports, re-exports,
import-types and static dynamic imports, following transitive edges. It scans all
production platform, observability and Tools server files and AI server imports
(including their current mixed-lib helpers). Forbidden fixtures prove rejection
of raw AI repositories, mixed HTTP helpers, relative/type/dynamic leaks, neutral
helper backdoors, reverse console imports and cross-gateway imports. Console
imports are restricted to public gateway surfaces and explicit page metadata.
No inconvenient production server files are excluded.

`server-ownership.test.ts` checks the actual production contributions and canonical
policy ownership. `catalog-workspace.test.ts` replaces source-text assertions
with native HTTP behavior: no caching, owner-key scope despite another dashboard
header, and no access without a key. Existing lifecycle/audit, identity rollback,
native streaming, durable restart and Tools transport suites use canonical paths.
Neutral database tests remain unconfigured and prove no AI tables are installed.

Historical deferrals, now completed by 004/005: physical Bun workspace manifests,
package exports/build/deployment moves; frontend domain views/navigation/shell
extraction; package-wide/browser import enforcement. AI-specific server helpers
and mixed browser/server types still exist under `src/lib` (analytics, pricing,
usage, Codex/transport/routing, `types.ts`), but none are dependencies of platform,
Tools or observability server code. Browser-facing dashboard types/clients and
view imports still use the current frontend layout. Console's browser page/scope
metadata validator is explicitly injected into observability until that frontend
metadata is extracted. This slice makes no claim that frontend/package ownership
is complete. Deployment/Docker acceptance will be repeated at the package slice;
this intermediate slice does not alter deployment files.

## Verification

Final `TMPDIR=/tmp/opencode bun run verify` passed all five checks: **608 unit
tests passed / 1 skipped / 0 failed**, lint including React Doctor (no warnings),
typecheck, production build and **all 93 Chrome E2E tests**. Full log:
`/tmp/opencode/rawroute-server-ownership-verify-final.log`; per-check logs:
`/tmp/opencode/rawroute-verify-a1fEUP/`. The command ran with no harness timeout.
The earlier full run also passed; the final run includes explicit offline-script
initialization fixes. `git diff --check` passed.

Actual disposable SQLite smoke (`tests/diagnostics/local-db-smoke.ts`) and the offline
100-event/one-trial dashboard benchmark also passed, including budget/public
reads and post-write scenarios. Logs: `/tmp/opencode/server-ownership-local-smoke.log`
and `/tmp/opencode/server-ownership-perf-smoke.log`. They used only disposable
paths under `/tmp/opencode`; no real environment files or application data changed.
Docker was intentionally not repeated for this intermediate source-tree slice.
