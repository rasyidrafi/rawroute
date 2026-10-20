# Multi-gateway modular monolith: ownership and rollout

> Historical slice record. Physical workspace extraction is now complete.
> Current package ownership, exports, DAG and extension instructions are in
> [005-workspaces.md](005-workspaces.md). Deferrals and verification numbers
> below describe that earlier slice, not the current implementation. Paths are
> updated where there is a direct equivalent.

Historical status: accepted; slices 1 and 2 and static server composition implemented.
Physical packages were deferred here and are now completed in 005. Frontend extraction is implemented in
[browser composition contracts](004-browser-composition.md). See
[slice 2 contracts](002-scope-lifecycle-audit.md) and
[server composition contracts](003-server-composition.md).

## Decisions

- Remain one Bun process and one deployable application. Use lightweight Bun
  workspace packages when physical moves happen, not microservices, a Storage
  Gateway, a plugin container, or a generic framework. Keep native Bun routing
  and HTML bundling. Preserve business behavior and canonical URLs.
- Dependency direction is console composition → platform / AI / Tools;
  AI → platform and Tools → platform. Platform never imports a gateway or
  console. Tools never imports AI repositories. Cross-gateway integration is
  an explicit console adapter, not a shared universal credential repository.
- Platform owns administrator identity, sessions, workspace records/lifecycle,
  request identity contracts, persistent audit, and the generic console shell.
  AI owns providers, endpoint credentials, routing/models/shares, gateway keys,
  pricing/budgets/usage, and the CLIProxy engine, including its global lifecycle.
  Tools owns the Executor transport/runtime integration.
- Ownership, access scope, and navigation placement are separate axes. A global
  CLIProxy navigation entry does not make its engine platform-owned. A shared
  Tools runtime does not change the workspace identity of an incoming request.
- Existing AI-issued gateway keys continue to authorize both AI and Executor.
  Console verifies the key and active owning workspace, then supplies Tools a
  minimal verified identity. Executor stays a global/shared upstream; requests
  run under the key owner's workspace, not a dashboard selector. No new key
  table, runtime-per-workspace, or upstream credential forwarding is introduced.
- One physical SQLite database, one process-owned connection, and one exclusive
  async transaction queue remain authoritative. Logical repository ownership
  does not imply separate databases. AI contributes persistence callbacks that
  execute on that connection inside the document write/delete transaction.
  Projection failures must roll back both canonical events and projections.
  Do not use Bun's synchronous transaction wrapper with async callbacks.
- Structural extraction needs no schema or data migration. Future shape changes
  require an explicit, tested offline command in `scripts/migrations/`, a backup,
  and conversion before deployment. Never request-time legacy conversion,
  retired aliases, or compatibility re-exports.

## Slice 1 integration boundaries

- `packages/platform/src/contracts/`: browser-safe workspace and verified identity types,
  plus a signing capability without raw key material.
- `packages/platform/src/server/database.ts`: neutral document/query/batch/transaction
  implementation and connection lifecycle. `packages/gateway-ai/src/server/local-db.ts` is the AI
  projection/query adapter, not a compatibility barrel. Its explicit
  `initializeAiPersistence()` installs the concrete callback object before the
  connection opens. Application composition, direct tests, and scripts initialize
  it explicitly. The adapter retains projection initialization, immutable
  archive validation, tree cleanup, duplicate history handling, and SQL paging.
- `packages/platform/src/server/identity.ts` and `session.ts`: metadata repository factory,
  password validation/hashing, cached reads, and session authentication factory.
  `packages/platform/src/server/runtime.ts`, configured by `apps/console/src/server/composition.ts`,
  composes the production instance with AI bootstrap
  writes. Metadata and the default indexed AI key are created in one transaction.
  Existing `<prefix>_system/meta`, version 4, environment defaults, seven-day
  cookie, HMAC encoding, forwarded HTTPS handling, and password gate are kept.
  Platform retains volatile identity across hot reloads independently of AI
  memory. Production memory mode validates fresh-bootstrap secrets before serve;
  AI key seeding also enforces its own non-default production-key requirement.
  Routing snapshots no longer contain the session secret; combo confirmation
  requests only a signing operation.
- `packages/platform/src/server/workspace-repository.ts`: workspace records, name indices,
  cache, and current lifecycle. `apps/console/src/server/composition.ts` supplies log
  deletion and the AI cleanup operation. AI owns index removal and key-cache
  invalidation; platform never reaches into mutable AI maps or key indices.
  Slice 2 replaces that synchronous flow with registered resumable participants
  and a persistent deletion journal. AI cleans its attributed resources; platform
  finalizes only its workspace record/name index. Tools remains global.
- `packages/gateway-ai/src/server/integration.ts`: adapts verified AI keys to platform request
  identities. Executor takes authentication and operational recording as explicit
  dependencies; its browser-safe status types live in `packages/gateway-tools/src/`.
  Tools has no transitive AI dependency through the AI-aware recorder. AI key
  lookup and active-workspace validation remain AI authentication behavior.
- ESLint restrictions and resolved AST-based transitive dependency tests guard
  all platform server code, all Tools server code and neutral observability.
  Neutral concurrency, in-process cache and authentication defaults are under
  `src/shared`; there are no gateway-dependent lib exceptions for platform.
  Full package exports/dependency checks supersede this guard in the move slice.
  Tools has no transitive AI-aware recorder, credential or repository dependency.

## Rollout and intentionally unresolved boundaries

1. Establish these foundations and verify unchanged behavior in the current tree.
2. Completed in slice 2: platform-owned persistent audit separate from operational
   logs. AI declares its security document catalog at its persistence adapter.
3. Completed in slice 2: strict required workspace context, request/stream/job
   admission/drain, shared-owner lifetime capture, durable resumable deletion.
   Default selection remains explicit at bootstrap/public boundaries.
4. Completed in the server ownership slice: explicit static route and lifecycle composition,
   removing HTTP's CLIProxy-specific timeout knowledge and password-gate wiring
   where appropriate. All canonical route/access declarations are retained.
5. Move physical owners into Bun workspace packages with browser/server exports,
   move neutral leaves, split remaining mixed domain types, and enforce the full
   dependency graph. No wholesale domain move is part of slice 1.

## Baseline

Before extraction: clean git tree; 543 unit tests pass / 1 skip; lint, typecheck,
and build pass; 93 Chrome E2E tests pass. Command:
`TMPDIR=/tmp/opencode bun run verify`. Captured baseline:
`/tmp/opencode/rawroute-architecture-baseline.log`.

## Slice 1 verification

- `TMPDIR=/tmp/opencode bun run verify`: all five checks passed, including all
  93 Chrome E2E tests. Log: `/tmp/opencode/rawroute-slice1-verify-final.log`;
  per-check logs: `/tmp/opencode/rawroute-verify-aAVxwf/`.
- After the final dependency/owner-scope tests and production-memory bootstrap
  guard were added: `bun --no-env-file test --isolate` passed 553 tests / 1 skip,
  with no failures; lint, typecheck, and production build passed again.
  Logs: `/tmp/opencode/rawroute-slice1-unit-final.log` and
  `/tmp/opencode/rawroute-slice1-lint-final.log`.
- The final rebuilt production memory-mode smoke test confirmed missing session
  secrets fail before serve, and configured bootstrap login retains mandatory
  password rotation and signed-session verification. Log:
  `/tmp/opencode/rawroute-slice1-memory-smoke.log`.
- An earlier verification attempt was interrupted by a 120-second harness
  timeout, not a test assertion; the timeout-free rerun above completed.

Work remains uncommitted for independent review.

## Slice 2

See [`002-scope-lifecycle-audit.md`](002-scope-lifecycle-audit.md) for completed
contracts, persistence decisions, concrete audit catalog, lifecycle failures and
regression coverage. No package move, module registry, framework, Storage Gateway,
remote Tools deletion, compatibility route or user-account rewrite is included.
