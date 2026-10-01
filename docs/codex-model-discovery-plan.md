# Dynamic Codex model discovery

Research date: 2026-09-29. Status: implemented using CLIProxy route discovery and demand-driven refresh. Missing records remain selectable with a stale indicator; direct OpenAI discovery is deferred. Refresh status uses Redis and model observations are persisted in the provider store.

## Recommendation

Replace RawRoute's fixed Codex seed list with a workspace-scoped synchronizer that reads the models CLIProxy has registered for the workspace's mapped Codex accounts. Keep manually created mappings user-owned. This removes the need for a RawRoute release whenever CLIProxy learns a new model.

CLIProxy already updates its catalog at startup and every three hours. Its live remote catalog currently contains `gpt-6.1-sol` in the team, plus, and pro sections. RawRoute is the missing synchronization layer.

This discovers **CLIProxy-supported routes**, not proof that OpenAI has enabled every model for an individual account. CLIProxy assigns OAuth models using plan-tier catalog data. Direct OpenAI discovery is discussed below because that distinction affects the meaning of “available.”

## Current behavior

- `src/lib/codex.ts:11` contains ten hardcoded model mappings. `ensureCodexProvider()` seeds them when the Codex provider page or login flow requests the provider.
- `src/lib/cliproxy.ts:469` builds RawRoute's `/v1/models` response from its own stored models, providers, aliases, and combos. It does not discover CLIProxy's models.
- Codex inference forwards to `rr-codex-<workspace hash>/<upstream model>`. Discovery must verify that exact workspace-prefixed route exists.
- `src/lib/types.ts:73` supports only `builtin` and `custom`. The store, admin API, and dashboard prohibit editing/deleting built-ins.
- The current seeding loop can overwrite a custom entry if its gateway ID matches a built-in. The replacement must explicitly preserve custom ownership, including ID collisions.
- `docs/cliproxy-coverage.md` describes the fixed catalog as intentional behavior and must change with the implementation.
- `docker-compose.yml` defaults to CLIProxyAPI `v7.3.4` with a pinned digest. These findings are from that tag; the running image can differ through `CLI_PROXY_IMAGE`.

## Verified upstream behavior

1. CLIProxy fetches its maintained remote catalog on startup and every three hours, preserving its current catalog when fetching fails. Model changes trigger per-auth model re-registration.
2. `GET /v0/management/auth-files/models?name=<auth-file>` returns that auth file's registered models: `id`, optional `display_name`, `type`, and `owned_by`.
3. Registered models may include both bare and workspace-prefixed IDs. Only the exact expected workspace prefix should qualify a route for automatic import; normalize and deduplicate after validating it.
4. OAuth Codex registration chooses the free/team/plus/pro catalog using the account's plan. This endpoint does not perform an authenticated OpenAI catalog request.
5. CLIProxy routing checks its model registry. Adding an OpenAI-discovered model only to RawRoute is insufficient if CLIProxy has not registered it.
6. OpenAI's Codex client separately requests `/backend-api/codex/models?client_version=<version>` with its authenticated session, parses a `models` array, and caches results. This is different from the public API-key `/v1/models` endpoint.

## Implementation plan

### 1. Add discovery and refresh state

- Add a management helper in `src/lib/cliproxy-codex.ts` and a new `src/lib/codex-model-discovery.ts` orchestration module.
- Resolve account mappings through existing workspace-scoped storage and live CLIProxy auth-file state. Verify file ownership/prefix; exclude disabled or missing accounts from fresh availability.
- Fetch per-auth registered models with bounded concurrency and request deadlines. Union valid workspace-prefixed routes across eligible accounts and retain per-account membership.
- Validate response shape and IDs. Distinguish an actual successful empty catalog from HTTP failures, invalid JSON, or missing mappings. Neither failures nor suspicious empty responses should erase saved models.
- Persist refresh status and last-good observations per workspace/account: last attempt, last success, error, first/last seen, and route membership. Account removal/reconnection invalidates the relevant membership/cache.
- Start with a five-minute RawRoute freshness interval and a distributed Redis lock plus in-process request deduplication. This polls CLIProxy's current state; it does not accelerate CLIProxy's three-hour upstream refresh.
- The auth-file endpoint has limited metadata. Any enrichment must remain optional and must never be used to infer access to a model. Do not invent model-specific reasoning capabilities from its name.

### 2. Reconcile managed models safely

- Introduce `source: "discovered"` alongside `custom` and transitional legacy `builtin`.
- Add an internal transactional reconciliation operation in `src/lib/store.ts`, covering the PostgreSQL-backed document abstraction and memory test backend. Preserve gateway reservations, provider counts, routing revisions, and cache invalidation.
- Import new models as `codex/<registered suffix>` and enable them by default when a valid eligible route exists. Preserve the existing model/document ID when updating managed metadata.
- Keep manual names, upstream mappings, reasoning overrides, and enabled state user-owned. A gateway-ID collision with a custom model is skipped and reported, never converted into a discovered entry. Enforce this within the write transaction as well as discovery's initial read.
- Migrate existing built-ins in place; stop reseeding the fixed array. Preserve aliases, combos, model shares, pricing associations, and user-disabled state. Legacy rows not observed in the catalog remain retained/unverified initially.
- Separate user enablement from last-observed availability. Recommended initial policy: additive import, retain absent models with a stale/unavailable indication, and never automatically delete records or references.
- Do not recreate user-suppressed discovered models as enabled during the next refresh. Expose suppression through an enabled toggle rather than deletion.

### 3. Integrate refresh and dashboard behavior

- Trigger refresh after successful account connection and account enable/remove changes.
- On Codex provider reads and gateway model-list reads, return saved models promptly and schedule a due refresh through the workspace-scoped `scheduleWorkspaceTask()` runner, carrying explicit workspace context. Bound any cold-start wait.
- This is demand-driven refresh: an idle deployment catches up on its next relevant request. If updates must occur during complete inactivity, add a scheduled worker invoking the same synchronizer.
- Keep inference requests independent of catalog-fetch availability.
- Add **Refresh models**, **Auto-discovered / Custom**, last successful refresh, and stale/error status to `src/components/dashboard/provider-detail-view.tsx`.
- Add an authenticated, workspace-scoped refresh route. It forces RawRoute to reread CLIProxy; the UI must not imply it forces CLIProxy's remote catalog updater.
- Update admin mutation rules so discovered identity fields are system-managed while enable/disable remains user-controlled. Custom model CRUD remains user-owned.
- Update provider counts, `/v1/models`, and routing caches consistently after reconciliation. Use the task runner so refreshes retain workspace ownership and drain on shutdown.

### 4. Verify behavior

- Replace the hardcoded-name assertion in `src/lib/codex-models.test.ts` with behavioral discovery tests using a previously unknown model ID.
- Verify that the new ID appears in the dashboard data and `/v1/models`, then forwards using the expected workspace-prefixed CLIProxy model.
- Cover custom-ID collisions, disabled models, concurrent refresh/manual writes, legacy migration preserving references, malformed/empty responses, timeouts, stale fallback, and removed/reconnected accounts.
- Cover two workspaces and mixed-plan accounts: union within a workspace, no imports from another workspace, and routing only through CLIProxy credentials registered for that model.
- Run relevant Vitest suites, typecheck, and lint; add an integration fixture proving a model absent from RawRoute's source becomes usable after refresh.
- During deployment validation, inspect the running CLIProxy image, updater logs, and per-auth catalog. A real inference check is still needed to establish that a particular account can actually use `gpt-6.1-sol`.

## If direct OpenAI account discovery is required

The existing `cliProxyCodexApiCall()` helper can broker an authenticated GET to the official Codex catalog without RawRoute storing OAuth tokens. A follow-up can retain official visibility/reasoning metadata and compare account results with CLIProxy-registered routes.

However, official discovery alone cannot enable a route unknown to CLIProxy. Such entries must be shown as pending CLIProxy support. For fully automatic day-zero support independent of the maintained CLIProxy catalog, account-scoped discovery must also be implemented in CLIProxy's registration layer (preferably upstream), with token refresh, client-version compatibility, prefixing, and metadata handling. Faking an alias to an older model would not solve this.

The recommended initial implementation needs no new OpenAI client-version pin and no CLIProxy fork. It removes RawRoute model-list maintenance but still depends on CLIProxy's catalog and protocol compatibility updates.

## Decisions to confirm

1. Is CLIProxy-supported model discovery sufficient, or must discovery reflect each account's official OpenAI catalog immediately, even before CLIProxy supports the route?
2. When a model disappears upstream, should it remain selectable with a warning, or become unavailable after repeated successful observations? Recommended: retain its record and references, expose its status, and avoid automatic deletion.

## Sources

- [CLIProxy v7.3.4 remote updater](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.4/internal/registry/model_updater.go)
- [CLIProxy v7.3.4 refresh callbacks](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.4/sdk/cliproxy/service_plugins.go)
- [CLIProxy v7.3.4 per-auth catalog endpoint](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.4/internal/api/handlers/management/auth_files.go)
- [CLIProxy v7.3.4 plan-based registration and prefix handling](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.4/sdk/cliproxy/service_models.go)
- [CLIProxy maintained live catalog](https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json), fetched during this research; includes `gpt-6.1-sol` in team/plus/pro.
- [OpenAI Codex model endpoint client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs)
- [OpenAI Codex catalog manager](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/manager.rs)

Evidence is repository inspection and a fetch of the public CLIProxy catalog. No connected production account was queried and no real inference request was made.
