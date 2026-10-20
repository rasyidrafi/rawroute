# Offline dashboard benchmark

Run `bun run --no-env-file tests/diagnostics/dashboard-perf.ts [events=10000] [trials=3]`.
The supported maximum is 100,000 events and 10 trials. No server, network,
repository data directory, `.env`, or live credentials are used. Child processes
receive an explicit allowlisted environment and SQLite backend in development
mode (test mode would silently select memory). Workers reject `fetch`/preconnect
before loading application modules. This blocks application `fetch` calls; it is
not a general network or filesystem sandbox. Internal worker path checks prevent
accidental use of the repository default, not maliciously crafted paths.

Each invocation owns a fresh `/tmp/opencode/dashboard-perf-9eba132-*` directory.
It retains structured stage logs, row counts, exact response samples, metric
SHA-256 hashes, and the synthetic base database. Individual trial database copies
are removed after use. Two workspaces each have four keys and three model IDs;
events span 30 days, including aligned and partial hour/day ranges, failures,
zero/missing/nonzero durations, and mixed cache usage. Usage recording uses the
real atomic raw/projection write path; synthetic key metadata is seeded directly.

Seeding is separate from reads. Each read trial starts a fresh worker on a copy
of the same fixture, then measures application-cold, warm, and post-write reads.
“Cold” does **not** mean filesystem-cold. Cases cover Overview 24h/7d/30d,
aligned/partial boundaries, private/public Usage, all-time/budget presets, first
without budgets and then with four enabled budgets per workspace. A final
100-write sample compares the instrumentation flag off/on on identical copies.
These are synthetic results, not production load estimates or HTTP latency.
Fixture events have fixed timestamps (September 15–October 15, 2026). The custom
budget window ends at the later of October 16, 2026 and tomorrow UTC, avoiding
automatic window rollover. Keep the same benchmark date/window when comparing
optimizations. Legacy-field metric hashes exclude `generatedAt`, the additive
`coverage` metadata (reported separately), and, for all-time Usage, `range.to`
(which ends at wall-clock time). Exact Overview ranges and Usage range
labels, starts and granularities are included. Exact samples and response hashes
retain every field. Summary lines report repeated median/min/max latency and
response bytes.

For server diagnosis, `DASHBOARD_PERF_LOG=1` enables bounded structured recorder
events and sanitized JSON console lines. It includes stage durations, row counts,
Usage cache outcomes, canonical bucket/raw-edge/history counts and builder completion.
Overview duration sums/counts now come from the same bounded range query, not a
separate raw-duration scan.
The flag is read at module initialization; restart to change it. It is silent by
default and never records response payloads or credentials.

## Canonical-reader comparison (2026-10-15)

Controlled 100k-source fixture (about 50k events per workspace), identical offline-
converted copies, three sequential fresh workers per scenario/configuration, Bun
1.4.3. Principal medians below have instrumentation **off**; no verification or
profiling load ran alongside these trials. Budgets are enabled.

| Scenario | Phase | Legacy reader (ms) | Canonical reader (ms) |
| --- | --- | ---: | ---: |
| Overview 30d aligned | Cold | 1288.464 | 52.789 |
| Overview 30d aligned | Warm | 126.775 | 7.842 |
| Overview 30d aligned | Post-write | 1217.369 | 13.531 |
| Private all-time Usage | Cold | 1164.492 | 56.646 |
| Private all-time Usage | Post-write | 1101.630 | 11.682 |

All 360 existing-field hashes and supported exact range fields matched across
logging on/off, budget on/off, ten scenarios and three phases. Coverage is an
intentional additive field, not part of that legacy-field hash. Partial durations
are explicitly reported; fixture financial coverage remains complete.

Original-HEAD versus final write-only median-of-worker-medians was 0.945 versus
0.964 ms (logging off): about 2% net overhead in overlapping trial ranges, not
evidence of free projection writes. This includes retiring obsolete rollup/counter
writes. The separate Stage A dual-write baseline was 1.111 ms. Production traffic,
durability/storage differences and contention can change these results.

The implementation handoff retains full medians/ranges, logging-on series, counts,
stage traces, payload copies, checksums and limits in
`/tmp/opencode/dashboard-perf-9eba132-stage-b-benchmark-report.md`; final raw samples
are `after-calendar-final-results.json` beside `before-final-results.json` in
`/tmp/opencode/dashboard-perf-9eba132-stage-b-control-disk-el9d64q4/`.
