# Frontend empty-state audit

This historical audit covered browser-rendered empty collections and no-result
states in the original mixed component/page tree. Those views now live in their
owner packages' `src/web/`; see [workspace ownership](architecture/005-workspaces.md).
It was checked against conditional list
rendering, zero-length collections, search-result branches, and existing
empty-copy strings. All included data-empty states use
`packages/ui/src/empty-state.tsx`; table rows use the `table` treatment, and
content inside an existing card, dialog, popover, command list, or terminal uses
the borderless `embedded` treatment to avoid nested cards and duplicate borders.

The default treatment is a rounded bordered card with a centered muted circular
icon, semantic heading, description, and optional action slot. Compact treatment
keeps the same hierarchy in denser contexts. `EmptyTableRow` and the retained
`EmptyRow` adapter in `packages/ui/src/resource-feedback.tsx` provide valid table
markup and preserve table headers and actions.

## Included surfaces

| Surface | Empty state and disposition |
| --- | --- |
| Providers (`providers-view.tsx`) | Regular provider and Codex provider tables use centered table treatment; add/open actions and descriptions remain available. |
| Provider detail (`provider-detail-view.tsx`) | Empty credential and model tables use table treatment. The `authType: none` case explicitly says API keys are not required; account and key cases retain their separate meaning. |
| Budgets (`budgets-view.tsx`) | Empty budget table, no/unbudgeted gateway-key selector, no enabled models, filtered model search, empty Unlimited Mode history, and missing Codex account selector use shared treatments. Existing budget metrics and Unlimited Mode status copy remain. |
| Model pricing (`model-pricing-view.tsx`) | Empty groups, available-model picker, repricing history, context-tier editor, and canonical-model catalog/search use table, embedded, or compact treatments. Canonical catalog errors remain error text, not empty results. |
| Routing (`aliases-view.tsx`) | Empty aliases, combos, and shared-model tables use the shared table pattern; the legacy `EmptyRow` adapter now renders the same primitive. |
| Alias and combo dialogs (`alias-form.tsx`, `combo-form.tsx`) | Missing provider/model targets, no eligible combo targets, and an empty fallback order use compact embedded states. Existing controls and form actions remain. |
| Model sharing (`model-share-button.tsx`) | No active recipient workspaces use a compact embedded state. Loading skeletons and request failures remain distinct. |
| Endpoint keys (`endpoint-key-view.tsx`) | No gateway API keys use an embedded state; the existing Create key action remains in the card header. |
| Usage (`usage-view.tsx`, `overview-usage-view.tsx`, `usage-panels.tsx`) | The all-empty overview, sparse panels, and empty usage table use the shared primitive rather than a usage-local duplicate. |
| Request logs (`request-logs-view.tsx`) | The existing “not available yet” placeholder is presented as an embedded state without changing its meaning. |
| Tool Gateway (`tool-gateway-view.tsx`) | Pages that intentionally show no workspace-scoped Executor data use an embedded state. Disabled, checking, and unavailable service statuses remain status messages. |
| Public analytics (`pages/public.tsx`) | An empty public-workspace list uses the shared card treatment inside the public layout. API errors and loading remain separate. |
| Console and system logs (`logs/log-results.tsx`) | No matching terminal logs use a compact embedded state with explicit console foreground, muted, and icon-surface tokens. Initial loading remains skeletons, populated logs remain rows, and a load error does not also show a no-results state. Chrome coverage checks computed text/icon contrast in both light and dark dashboard themes. |
| CLIProxy releases (`global/cliproxy/cliproxy-view.tsx`) | An empty exact-release list is explained while preserving the Install latest action and release error status. |

## Intentional exclusions

- Loading and refresh skeletons, API/load errors, provider 404s, and session
  errors are not empty states. Their existing retry, alert, and not-found
  behavior remains.
- Cell-level values such as the usage model-list em dash and Codex quota `N/A`
  are compact data/status values, not empty collections. Status badges, zero
  metrics, “No version configured,” “No budget limits configured,” and “No
  models are excluded” remain inline status copy.
- The overview preview uses fixed demonstration arrays rather than a live
  optional collection. Those sample rows are not an empty-data branch.
- The public workspace selector is only rendered after a workspace is selected;
  the empty-list branch is handled by `PublicPage`. The authenticated workspace
  menu has a repository-guaranteed default workspace and keeps its existing
  loading/unavailable label.
- Static protocol, auth, date, and time options are not data-backed result
  collections and do not need empty-result states.

## Regression coverage

- `tests/components/ui/empty-state.test.tsx` checks semantic heading/description,
  status semantics, circular icon, default card, compact embedded treatment,
  and the optional action slot.
- `tests/e2e/empty-state-audit.e2e.ts` runs in the configured existing Google
  Chrome project. It checks provider loading/empty/populated tables, key and
  request-log states, console-log loading/empty/populated/filtered results,
  public workspaces, routing dialogs/tables, budgets, pricing search, tools,
  coding agents, provider credentials/models, and model sharing. It captures a
  provider empty-state screenshot in the Playwright test output directory.
- `tests/e2e/usage-empty-states.e2e.ts` checks usage loading, empty, sparse,
  populated, and refresh states through Chrome.
