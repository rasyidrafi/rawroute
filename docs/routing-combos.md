# Unified model routing

Create a combo with one local or shared model to expose an alias. Add up to eight
models for ordered fallback. Shared members retain their grant ID, so revoking a
share makes the member unavailable.

## Existing installations

Before starting this version, stop RawRoute and convert existing aliases:

```sh
bun scripts/migrations/aliases-to-combos.ts
bun scripts/migrations/aliases-to-combos.ts --apply
```

Use the same `SQLITE_PATH` (or `RAWROUTE_DATA_DIR`) and
`DATABASE_COLLECTION_PREFIX` as the server. The first command is a dry run.
Applying creates a SQLite backup at `<database>.before-aliases-to-combos`, then
converts all workspaces atomically. Gateway IDs, names, creation dates, shared
grants, and gateway ID reservations are preserved. Existing fallback members
that reference aliases are replaced with their targets, retaining order and
overrides. Their cached policy validation is cleared.

If a fallback chain references the same target through multiple aliases, the
conversion stops without changing data; remove those duplicate targets before
retrying. Re-running after successful conversion is a no-op.

## Budget controls

Gateway discovery and budget model selectors use the same workspace routing
catalog. A combo is available when at least one local member or shared grant is
available. Saved unavailable selections remain visible and can be retained or
removed; unavailable entries cannot be newly selected.

Unlimited Mode exclusions apply both to the requested combo ID and to the local
model that executes the request. Excluding a combo blocks that entry point;
excluding a local model also blocks it through other combos. Activation saves the
exclusions displayed in the dialog before enabling the bypass. A failed save
prevents activation.

Beyond Limits can allow a local model across entry points, or a combo's local
members only when called through that combo. A member denied by its budget is
skipped so another permitted member can run. If all members are denied, the
request returns the budget error. Usage still counts after exceeding the limit,
and configured pricing is required. Upstream quota responses retain their
existing routing and Retry-After handling.

Shared members always use the owner's workspace budget and model policies under
the recipient's shared-workspace budget identity. A recipient combo exception
cannot bypass the owner's rules. The selector identifies shared members' budget
owners, and revoked grants make members unavailable.
