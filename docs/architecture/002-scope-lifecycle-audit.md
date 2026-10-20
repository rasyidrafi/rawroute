# Slice 2: required scope, workspace deletion, durable audit

> Historical slice record. Physical workspace extraction is now complete.
> Current package ownership, exports, DAG and extension instructions are in
> [005-workspaces.md](005-workspaces.md). Deferrals and verification numbers
> below describe that earlier slice, not the current implementation. Paths are
> updated where there is a direct equivalent.

Status: implemented; uncommitted pending independent review.

## Required workspace scope

`workspaceContext()` and `currentWorkspaceId()` throw without a selection.
Workspace repositories use required context or an explicit workspace identifier
for global indices/cleanup. There is no implicit Default fallback. Identity,
session verification, global settings and the global Tools deployment remain
usable without a workspace.

Default remains intentional for workspace/bootstrap creation, the initial AI key
and public dashboard/usage selection when the public URL omits a workspace.
Global metadata bootstrap explicitly writes the AI key to Default; it does not
establish ambient scope. All canonical URLs/access declarations remain unchanged.

`runInWorkspace` synchronously acquires platform activity admission. Nested work
inherits it; async callbacks hold it through settlement. A detached continuation
cannot reuse a settled scope. `trackBackgroundTask` retains admission through
stream accounting. `scheduleWorkspaceTask` captures identity, verifies the active
workspace before execution, and participates in shutdown drain.

Shared-model resolution attaches owner admission to the consumer lifetime,
including stream monitoring and both usage copies. Sharing mutations attach
active recipients before queuing persistence, preventing owner-side writes from
recreating grants after recipient cleanup. AI also checks admission at the actual
SQLite write boundary, rejecting captured late references. Activity state and
scope survive compatible Bun hot reloads.

Shutdown still stops/drains HTTP, drains tracked accounting/jobs, drains workspace
coordinators (including disconnected HTTP callers), stops CLIProxy, then closes
database/cache. Deletion HTTP calls disable the idle timeout while draining.
Executor streams have no later local accounting
writes. There is no generic job/workflow engine or Tools deployment per workspace.

## Platform deletion coordinator

Platform owns `createWorkspaceRepository({ participants })` and activity admission.
Console registers stable unique IDs `ai`, then `operational-logs`. Platform never
imports AI/Tools. State transitions:

1. Default is undeletable. Deletion requires exact name confirmation and execution
   outside the workspace's own activity (the HTTP endpoint is global session
   administration). Close new admission synchronously.
2. Atomically persist workspace `status: deleting`, pending deletion journal and
   request audit. Failure before commit reopens admission and leaves it active.
   Confirmation is revalidated transactionally against rename races.
3. Publish deleting status and drain admitted requests, stream monitors, jobs and
   shared-owner activity. Existing admissions may finish accounting; no fresh
   admission is allowed. Cleanup starts only after drain.
4. Run participants sequentially. Atomically checkpoint each successful ID with
   its audit. On failure retain deleting status, completed IDs, `state: failed`,
   stable failed-participant ID where known, timestamp and failure audit. Never
   persist exception text. If storage itself fails, the earlier pending journal
   still supports recovery; recording that failure may also be unavailable.
5. Only after every participant succeeds, atomically delete platform workspace
   and name index, retain a complete journal/tombstone and append completion
   audit. Admission remains closed; IDs are not reused.

Process-wide duplicate retries, including hot reloads, join one promise. Retries
skip durably completed participants. Participants must be idempotent: side effects
can succeed before checkpoint persistence fails. There is no distributed
transaction or exactly-once remote side-effect claim.

Startup initializes the shared AI engine, restores journal admission tombstones
and attempts recovery before serving. Failures stay unavailable and retry through
the same canonical DELETE endpoint/name confirmation; there is no retry alias.
One failed workspace does not prevent another from recovering.

### AI-owned cleanup

The AI participant uses a coordinator-only cleanup capability, preserving mappings
until external cleanup succeeds so retries/restarts find the same resources:

- Cancel the workspace's durably attributed pending Codex sessions through the
  shared management boundary; remove attribution only after cancellation succeeds
  or returns 404 (confirmed absence). The AI-owned
  `<prefix>_codex_login_cancellations` collection stores only workspace ID and
  sensitive upstream state under the opaque login ID, outside audit and workspace
  subtrees. Cache loss/restart or the five-minute interaction TTL never establishes
  upstream absence/expiry. Other upstream statuses retain attribution and block
  deletion until a later successful/404 retry. Successful authorization also
  removes attribution, because that session completed and the mapped credential
  is then handled by credential cleanup.
- The existing five-minute cache interaction and global login lock remain
  unchanged; expired/cancelled UI interactions release only that caller's lock.
  They do not discard unresolved cancellation ownership. Expired sessions are not
  automatically resumed, and no upstream expiry duration is inferred locally.
- Remove only workspace/provider-namespaced managed provider projections, without
  changing global routing strategy. Delete only mapped Codex auth files not
  mapped in another active workspace. Already-removed remote files/sessions
  (404) count as successful idempotent cleanup.
- Remove source/recipient shares, gateway-key indices/lookup caches, routing
  revision, and AI subtree: providers/credentials/models/aliases/combos, pricing,
  budgets, usage and usage projections/history.
- Clear workspace AI memory, pricing/usage/read caches, Codex usage/discovery and
  provider-projection caches. Derived analytics caches may be invalidated globally;
  other workspaces' canonical data is unchanged.

AI preserves the platform workspace root until finalization. There is no Tools
participant: no workspace-owned upstream deployment exists. No arbitrary remote
Tool delete is performed. Operational-log invalidation is separate and idempotent;
neither participant deletes audit.

## Persistent platform audit

`packages/platform/src/server/audit.ts` owns append/query, storing `<prefix>_audit` outside
workspace subtrees. It exposes no update/clear API or browser ingestion.
`queryAudit({ workspaceId?, limit? })` is server-only, capped at 1,000 records.
No UI/public endpoint is introduced.

Events contain opaque ID, server time, actor (`administrator`, `anonymous`,
`system`, `gateway`), optional workspace ID, fixed action/resource category,
result (`started`, `success`, `failure`) and correlation ID. HTTP correlation is
the server-generated request ID; direct system work generates one. The single
administrator stays one stable identity, not a new account system.
Gateway-triggered mutations additionally carry the verified opaque key-record
`actorId`, never the supplied key value. No bodies,
names, credential values, auth-file names, URLs, responses or exception text are
copied into audit. Fixed resource categories deliberately avoid user-controlled
resource labels. Browser operational reports are not authoritative audit.

| Action | Authoritative boundary |
| --- | --- |
| `auth.login` | Actual login, including malformed/wrong-password failures |
| `auth.logout` | Logout; actor derived from session verification |
| `auth.password` | Transactional password changes; route validation failures |
| `identity.update` | Bootstrap/replaced metadata and other identity changes |
| `workspace.create`, `.rename` | Workspace/name-index transaction, including Default bootstrap; rejected attempts are failure events without supplied names/unverified identifiers |
| `workspace.delete.request`, `.participant`, `.failure`, `.complete` | Deletion state/checkpoint transitions |
| `credential.create`, `.update`, `.revoke` | Gateway keys, provider API/OAuth credentials, bootstrap, priority/name/enabled changes |
| `config.update`, `.delete` | Providers, models, aliases, combos, sharing, budget/Unlimited settings/windows/sessions, pricing groups/versions |
| `oauth.remote` | Shared CLIProxy management mutations (OAuth sessions/files, provider/config projections), canonical upstream OAuth callbacks, and reset-credit consumption |
| `cliproxy.lifecycle` | Shared lifecycle mutations: install/start/stop/restart |

AI's concrete document catalog is `packages/gateway-ai/src/server/ai-audit.ts`, contributed beside usage
projection callbacks by `packages/gateway-ai/src/server/local-db.ts`. Platform knows no AI collections.
Usage events, derived routing revisions, projection bookkeeping and pricing-job
progress are not independent security events. Cascaded credential revocation is
covered by workspace deletion lifecycle, not fabricated per-child events.

### Atomicity / failure semantics

- SQLite identity/workspace changes stage audit in their transaction. AI sensitive
  document callbacks append platform audit on the same exclusively held
  connection/transaction. Audit/projection failure rolls back documents, indices
  and audit together. Cache invalidation follows commit. Successful local security
  mutations cannot commit without audit.
- Memory mode performs synchronous mutation+event publication without intervening
  awaits. Identity mutators operate on a clone and publish only after success.
  Memory data, audit and journal deliberately remain volatile. Durable production
  audit/restart recovery requires SQLite.
- Remote operations cannot atomically commit with SQLite. Persist `started`
  **before** side effects; audit failure prevents execution. Persist redacted
  outcome before returning success. Returned HTTP errors are failures, not
  successes merely because a callback resolves. Crash/outcome-write failure leaves
  durable intent and potentially ambiguous remote state; existing idempotent
  retry/reconciliation remains authoritative.
- Login success is audited before returning its signed cookie. Password changes
  and deletion/checkpoint mutations are transactional. Required audit failure
  cannot be presented as successful mutation.
- Malformed JSON and JSON null at the authenticated canonical password endpoint
  persist a redacted `auth.password` failure before returning 400; audit storage
  failure instead produces 500 without changing identity.
- Audit survives operational-log clearing, workspace deletion, cache close and
  SQLite reopen; it has no operational-log retention limit/automatic expiry.

## Persistence evolution and deployment

Only new logical document collections (`_audit`, `_workspace_deletions`, and the
AI-owned `_codex_login_cancellations`) are added
to the existing document table. Workspace shape remains `active | deleting`,
identity remains version 4, AI record paths and usage projection schemas are
unchanged. No existing record is rewritten/converted, so **no offline conversion
or schema migration command is required for this slice**. Missing audit history
is not backfilled at request time. Existing deleting workspaces may start the new
coordinator with an empty pending journal and idempotent cleanup.
Pending OAuth cancellation records are created for new login starts; this is not
a conversion of existing documents. Before upgrading a version that tracked
pending sessions only in process cache, finish/cancel its active OAuth logins:
already-lost ephemeral state cannot be reconstructed by this version.

Deploy with a database backup and one process owning SQLite. Do not downgrade
with outstanding deletions: complete/retry them on this version first. Future
record/schema changes still require an explicit tested offline CLI under
`scripts/migrations/`, backup, and conversion before serving. Code/package moves
alone do not justify a migration. Physical packages/registrations were deferred
at this slice and are now completed in 005; no compatibility exports or alternate URLs were added here.

## Regression coverage

`tests/server/workspace-lifecycle.test.ts` covers memory and on-disk SQLite:
missing scope/explicit Default, global identity, two-workspace configuration/key/
usage isolation; failure after AI success, duplicate retry/reopen recovery;
in-flight/background/shared-owner settlement and actual shared native SSE; late
references and restored tombstones; durable redacted audit/log clearing; actual
login/password/logout/provider credential events; identity-mutator rollback;
audit-trigger rollback of credentials, identity/workspace writes and initial
deletion; checkpoint failure after side effects; remote intent/failure semantics;
mapped OAuth/pending-login cleanup without changing global Tools; canonical OAuth
callback and reset-credit intent/outcomes; disconnected-coordinator shutdown drain.
Existing domain
tests select explicit fixtures, not an ambient suite-wide Default fallback.
Review regressions additionally start a login through its authenticated canonical
endpoint, expire its local interaction, fail upstream cancellation, reopen SQLite
and clear the entire cache, then prove deletion recovery retries cancellation
before finalization. Password malformed/null regressions use the authenticated
canonical wrapper, verify persisted correlated failures after reopen, and inject
audit failure to confirm fail-closed responses.

## Verification before independent review

Final `TMPDIR=/tmp/opencode bun run verify` passed all five checks: **583 unit
tests passed / 1 skipped**, lint (including React Doctor, no warnings), typecheck,
production build and **all 93 Chrome E2E tests**. Full log:
`/tmp/opencode/rawroute-slice2-verify-final-complete.log`; per-check logs:
`/tmp/opencode/rawroute-verify-5wTUqo/`. The focused lifecycle/audit suite contains
30 passing tests (memory and on-disk SQLite). `git diff --check` also passed.
All work remains uncommitted; no real `.env` or application data was changed.

### Review fixes verification

The two review findings (durable pending cancellation ownership, malformed/null
password audit) are fixed. Targeted regressions passed **35 tests** across the
lifecycle/audit and login-cache suites; the lifecycle/audit suite now has 32 tests.
Full units passed **585 / 1 skipped / 0 failed**. Lint (including React Doctor),
typecheck, production build and `git diff --check` passed. Because login settlement
changed, the affected bootstrap/CLIProxy/OAuth Chrome suites were repeated:
**8 passed**; the earlier full 93-test browser result is retained above, not
claimed as a new full-browser run.

Logs under `/tmp/opencode/`:
`rawroute-slice2-review-{targeted,unit,lint,typecheck,build,browser}.log`.
