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
