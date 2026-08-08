# CLIProxyAPI coverage audit

Audit date: 2026-08-08. The audit was performed against the checked-out `../CLIProxyAPI` source and RawRoute’s current routes and dashboard code. `../CLIProxyAPI` was not modified.

## Ownership and coverage

| Capability | Owner | RawRoute coverage |
| --- | --- | --- |
| OpenAI chat/completions, Responses, Anthropic messages, Gemini, image/video, Codex direct paths | CLIProxyAPI | RawRoute forwards the supported HTTP paths through `/v1/*`, `/v1beta/*`, `/openai/v1/*`, and `/backend-api/codex/*`, after gateway-key authentication and model resolution. |
| Provider translation, upstream routing, retries, provider rate/concurrency limits, native model execution | CLIProxyAPI | Kept native; RawRoute does not reimplement or fork these behaviors. |
| OAuth login and credential refresh | CLIProxyAPI plus RawRoute | CLIProxy owns OAuth execution and token semantics. RawRoute owns the Codex account record shown in the dashboard and synchronizes its encrypted credentials into CLIProxy auth files. |
| Codex model resolution, workspace routing, and account priority | RawRoute plus CLIProxyAPI | RawRoute owns the fixed `codex/` catalog, alias resolution, workspace/API-key routing, and fill-first account priority. CLIProxyAPI receives the selected internal upstream target and performs OAuth execution, translation, and upstream forwarding. |
| Workspaces and workspace isolation | RawRoute | Stored and selected in RawRoute; the selected workspace controls gateway keys, providers, models, aliases, budgets, usage, logs, and Codex dashboard data. |
| Gateway API-key authentication | RawRoute | Required before inference reaches CLIProxy. The real key name is resolved from the global key index for historical usage rows. |
| Aliases | RawRoute | Resolved before forwarding and added to model listings. Provider-style IDs containing `/` are preserved, including migrated aliases such as `cx/gpt-5.6-sol`. |
| Budgets and admission control | RawRoute | Reservations and rejections happen before forwarding; CLIProxy remains responsible for upstream execution. |
| Usage events, rollups, cost/pricing, and public dashboard | RawRoute | Recorded around the CLIProxy response/stream and persisted in the canonical scoped PostgreSQL layout. CLIProxy request logs are not treated as the RawRoute usage database. |
| RawRoute provider/API-key/model administration | RawRoute | Implemented by the existing admin APIs and dashboard. Codex accounts use the same provider store with OAuth-specific fields and quota views. |
| CLIProxy management config, API-key list, logs, OAuth start/status/cancel, and auth-file status/delete | RawRoute wrapper over CLIProxy | Exposed only through authenticated RawRoute admin routes. CLIProxy management is not published directly to the host. |

## Codex synchronization contract

Every local Codex OAuth account is written to CLIProxy as a deterministic file named `codex-rawroute-<account-id>.json`. The payload retains the access token, refresh token, ID token, ChatGPT account ID, email, plan type, expiry, refresh timestamp, and disabled state. Saving, refreshing, enabling, or deleting an account invalidates the sync cache and performs a forced sync; read views reconcile at most once per five minutes.

RawRoute reads Codex provider/account/model records only from the canonical scoped PostgreSQL store. Account changes synchronize the encrypted credential projection to CLIProxyAPI; the upstream repository remains untouched and its model catalog is never written into RawRoute’s provider store.

## Deliberate boundary

RawRoute does not mirror CLIProxy’s standalone management control panel, plugin marketplace, or provider-specific management settings that are not part of the RawRoute dashboard. Those remain available only inside the private CLIProxy service and are not needed to implement a RawRoute feature. New RawRoute features should either call an existing CLIProxy management endpoint or be implemented in RawRoute’s wrapper layer; they should not be added to `../CLIProxyAPI`.
