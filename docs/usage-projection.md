# Canonical usage analytics

This version requires an **offline conversion before starting against existing
usage data**. There is no request-time legacy conversion or old-reader fallback.
An empty database initializes automatically only when it has no existing usage
sources. No live database has been converted as part of implementation/testing.

## Storage and writes

`usage_projection_meta` records schema version 2, the configured IANA timezone
and document prefix. Startup and subsequent transactions reject mismatches with
an offline-migration instruction; changing timezone requires an explicit rebuild.

`usage_buckets` is keyed by workspace, granularity, actual bucket start, key ID
and model ID. Typed additive columns cover requests, input/output/cache tokens,
total and successful-only spend, confidence/status counters, duration sum/count,
latest event/success timestamps and measure coverage. Integer measures remain
nonnegative safe integers. Valid finite nonnegative durations include zero and
failed attempts; missing/string/negative durations do not enter their count.

Raw create/update/delete and projection deltas share the existing SQLite
transaction. Duplicate creates cannot increment twice. Repricing uses the actual
persisted before/after documents, including normalized token/confidence changes;
read caches are invalidated after every committed chunk. Late events are charged
by completion time, not a captured request budget context. Owner/consumer
workspace billing and the existing actual-spend-only admission/reservation policy
are unchanged. Legacy rollups, counters and baseline offsets are no longer read
or written by live analytics. Their original documents remain preserved archives.

Hourly buckets distinguish repeated DST instants and fractional-hour transitions.
Calendar days may have 23/25 or fractional lengths. Use stored endpoints, not
fixed-day arithmetic. Monthly runtime trends aggregate daily data rather than
requiring an additional write per event. Memory analytics use the same projection
and an hour index for boundary events, not a legacy reconciliation fallback.
Historical midnight folds can briefly enter the next date before returning to the
previous one; their daily buckets are separate contiguous intervals, not an
overlapping or out-of-bounds calendar estimate. Resolved intervals are cached by
timezone and civil date with a bounded cache.

Token coverage honors explicit usage metadata: unavailable, missing or partial
provider usage is not complete coverage even when normalization stores numeric
zero placeholders. Recorded numbers and money are unchanged. Older records
without completeness metadata retain the numeric-field fallback: all five token
measures must be nonnegative safe integers, and availability must be absent/true.
Complete zero-token responses are covered; unknown explicit metadata is not.

The Overview's **Recorded cache hit rate** uses separate additive paired measures:
`cacheUsageReadTokens / cacheUsageInputTokens`, plus `cacheUsageCoveredRequests`.
New events persist `cacheUsageKnown` from provider input/cache-read field presence
before normalization; missing output does not disqualify a known pair. Explicit
false excludes a pair even when overall token usage is complete. Older raw
events without this flag qualify only under the existing complete-token rule;
older partial events are excluded. Missing input/cache measurements never become
zero-percent hits. A known positive input with zero reads is 0%; no known positive
input is unavailable. This metric does not change token totals, costs or budgets.

The offline CLI also upgrades version 1, adding the paired columns and rebuilding
raw contributions and canonical history snapshots in one transaction. Historical
numeric totals alone do not prove cache coverage: only preserved source metadata
with explicit available/complete usage qualifies. The conversion preserves source
documents, history source JSON and financial coverage, backs up before applying,
and is an idempotent no-op on a second run. Use the existing stopped-writer
deployment conversion; do not start version 2 against an unconverted database.

Duration subtraction resets the sum to exactly zero when its valid-duration count
reaches zero. Other negative subtraction residues are clamped only within
`8 * Number.EPSILON * max(abs(previous), abs(delta))`, before SQL constraints.
There is no absolute tolerance floor. Larger negatives, nonfinite sums and all
integer/financial underflows remain errors in both backends.

## One shared bounded range reader

Overview, private/public Usage, budget windows and Unlimited Mode session windows
use `src/lib/usage-range.ts`:

1. Sum complete daily interiors from typed buckets.
2. Sum complete hours on the day edges (or throughout an hourly chart).
3. Aggregate the remaining, at most two, partial physical hours directly in SQL
   through `usage_projection_raw_events`. No full raw event payloads are decoded.

Queries use SQL sums/grouping and disjoint half-open intervals. Duration sum/count
arrive in the same range result; Overview does not issue a separate full-window
duration scan. Weighted latency is total valid duration divided by valid count,
never an average of bucket averages. Custom calendar date endpoints and empty
chart grids advance by real calendar boundaries, including DST folds/gaps.

Canonical historical contributions are removed from selected materializations
and added once at their actual native interval. This avoids counting both an
hourly source and its daily materialization. Daily/monthly history is never
invented as hourly observations. Unsupported trend intervals are gaps, not
fabricated quiet zero buckets. A complete native interval can still contribute
known summary/dimension totals when the selected chart resolution cannot split it.

The additive `coverage` response metadata reports included measure coverage,
omitted sources, unsupported trend resolution and financial uncertainty. Overview
and private/public Usage show an inline warning only for partial coverage. Unknown
zero totals and incomplete success/cache percentages render unavailable; latency
continues to identify its actual recorded-duration sample count.

Financial uncertainty affects only intersecting keys/windows (an unattributed key
is a wildcard). Enforced admission returns `BudgetUsageUnavailableError`/503, not
a guessed balance or a premature 429. Budget API values become `null` for unknown
spent/remaining/percent amounts, with `usageAvailable: false`; the UI does not
show remaining credit/progress. Unrelated keys/windows remain usable. Proven
failed-only history has zero successful spend even inside a partial interval.
Unlimited/disabled budget policy itself is unchanged.

## Historical source contract

`usage_projection_history` retains original source JSON, checksum, path,
workspace/dimensions, actual interval/resolution, classification and financial
state. Canonical normalized measures are separate from opaque source snapshots;
runtime never reconstructs them by interpreting legacy JSON.

Initial conversion:

- Rebuilds from canonical raw events, including events with missing old rollups.
  Runtime-rollup duplicates require canonical writer identity, valid stored
  numeric measures, full additive equality and any supplied matching
  confidence/status measures. Provider token completeness is separate: normalized
  missing/partial usage can match a stored rollup without gaining token coverage
  or creating artificial financial uncertainty. Equal request counts alone do
  not prove duplication.
- Preserves independent `ccs-usage-v2` hourly/daily/monthly sources at their real
  resolution. A declared hourly-derived daily copy requires matching measures
  and provenance. Historical DST wall-hour segments retain their actual bounds,
  including a two-physical-hour repeated wall hour.
- Preserves ambiguous overlap, unproven provenance, invalid/unaligned aggregates
  and unsupported raw timestamps with explicit exclusion/uncertainty. A zero
  failure counter alone does not prove complete historical success coverage.
  Missing status, durations, monetary measures or attribution never become
  invented successes, latencies or financial completeness.

All original document rows and metadata survive conversion. Flat legacy raw
events are copied offline into the sole scoped namespace; conflicting identities
abort. Archives are not runtime aliases. An intentional imported-event deletion
atomically changes `canonical-copy:<path>` to `canonical-copy-deleted:<path>`;
source snapshots remain and rebuild never resurrects them. An unexplained missing
active copy target still aborts.

After conversion, rebuild uses the canonical manifest, not later mutations of
legacy archives. New raw overlap removes the historical contribution atomically
and leaves its preserved remainder financially unknown. Timezone rebuilds retain
original historical intervals; incompatible resolution is excluded with financial
uncertainty, never reinterpreted or prorated. Unsupported source reconciliation
requires an explicit offline decision, not a runtime credit guess.

## Offline conversion and validation

For this checkout's Bull deployment, use the reviewed transaction in
[`scripts/deployment/README.md`](../scripts/deployment/README.md): `--check`,
`--prepare`, then the authorized `--deploy`. It performs the offline conversion,
private report validation, full-snapshot recovery and an ingress-gated cutover;
do not run the manual Compose sequence concurrently with it.

Confirm the existing `TIMEZONE` and `DATABASE_COLLECTION_PREFIX`, stop ingress,
the server and every background/maintenance writer, and preserve the old pinned
image plus a private full data-volume backup. Preview on an owned stopped copy
first. Source commands require an explicit existing path and timezone:

```sh
bun run --no-env-file scripts/migrations/usage-projection.ts \
  --sqlite /absolute/path/to/stopped-copy.sqlite --timezone Asia/Jakarta

bun run --no-env-file scripts/migrations/usage-projection.ts \
  --sqlite /absolute/path/to/stopped-copy.sqlite --timezone Asia/Jakarta \
  --apply --writers-stopped
```

Set `DATABASE_COLLECTION_PREFIX` explicitly if non-default. Dry-run opens read-only
and reports source/projection hashes, source classifications and workspace sums.
Daily sums and nonduplicated totals are separate because monthly-only sources
retain their resolution. These are known included contributions, not a promise
of financial completeness: review excluded/unknown sources against active budgets.

Apply requires the stopped-writer acknowledgement and exclusive SQLite connection
ownership with zero lock wait. This protects conversion itself; it cannot prove
an idle old process was stopped. A new private `VACUUM INTO` backup is integrity-
and source-checksum-validated. One exclusive transaction installs copies, buckets,
manifest and metadata, validates the full projection and unchanged original rows,
and rolls everything back on failure. Identical reruns are validated no-ops.
Existing backups are never overwritten; subsequent rebuilds require a new
`--backup /absolute/path/to/new-backup.sqlite` if a replacement is needed.

The production image includes `migrations/usage-projection.js` and
`predict-missing-usage-cost.js` in `/app/dist`; no server startup is needed to run
them. Illustrative Compose sequence, **only after review and backup approval**:

```sh
docker compose --env-file .env.local stop rawroute
# Select the reviewed pinned candidate image, and substitute the existing timezone.
RAWROUTE_IMAGE=<candidate-image> docker compose --env-file .env.local run \
  --rm --no-deps --entrypoint bun rawroute run --no-env-file \
  migrations/usage-projection.js --sqlite /data/rawroute.sqlite --timezone Asia/Jakarta
# Review the report, then repeat the same command with --apply --writers-stopped.
# Verify a second dry-run is unchanged before starting the new application.
RAWROUTE_IMAGE=<candidate-image> docker compose --env-file .env.local up -d rawroute
```

Keep ingress blocked until health, source totals, representative ranges and known/
unavailable budget states have been checked. Purge old public analytics responses
at any CDN, or allow their existing cache lifetime to expire; cache policy did not
change. If validation fails **before accepting new usage/configuration writes**,
keep writers stopped, restore the matched pre-conversion SQLite backup/full data
snapshot and old pinned image together, then start the old version. Never downgrade
an image alone or blindly overwrite post-upgrade usage with an older backup.
After new writes, first preserve the current database and plan an explicit offline
reconciliation/replay; there is no automatic reverse migration or live fallback.
Backups contain private instance data and must stay protected.

## Canonical maintenance

`sanitize-usage-integrity` and the old count-equality CCS `reconcile-usage` commands
are retired, not redirected. Canonical recording already derives correct failed/
confidence measures; the single projection conversion/rebuild CLI repairs derived
state from raw events and the explicit manifest without editing archives.

The missing-usage cost predictor keeps its empirical quantile/prior policy and
provider-recorded/idempotence exclusions, but reads canonical events only (no flat
archive double sampling). Use explicit dates; its historical default date range
is retained. It defaults to read-only planning:

```sh
bun run predict:usage --sqlite /absolute/path/to/stopped.sqlite --timezone UTC \
  --from=2026-10-01T00:00:00.000Z --to=2026-10-15T00:00:00.000Z
# Add --apply --writers-stopped and optionally --backup <new-file> after review.
```

Apply validates a private SQLite backup, checks that only planned canonical raw
documents changed, and rebuilds/validates projection and history **in the same
exclusive transaction**. Failure restores all raw/projection state. Live archive
writes are rejected; there is no second authoritative budget counter. Prediction
warmup likewise samples only canonical scoped events. Its existing once-per-process
sample warmup is separate from bounded usage/spend reads; estimator policy is not
changed by this migration.
