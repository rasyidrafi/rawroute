# This machine's deployment transaction

Canonical code is tracked here; private state, command logs and environment files
remain in the ignored `.local-deploy/state/` directory (0700, files 0600). Never
commit that directory or database backups. This tool targets the existing Bull
Docker daemon deployment; its fixed names and configuration checks are intentional.

After review, commit all application and workflow changes, then run:

```sh
python3 -m unittest discover -s scripts/deployment -p 'test_*.py'
python3 scripts/deployment/redeploy.py --check
python3 scripts/deployment/redeploy.py --prepare
# Only with deployment approval:
python3 scripts/deployment/redeploy.py --deploy
# After an interrupted transaction:
python3 scripts/deployment/redeploy.py --recover
```

`--check` is read-only and requires clean committed source. `--prepare` builds
that source and runs the packaged migration using the candidate image's Bun
runtime, on a disposable legacy SQLite fixture without network or credentials.
It validates preview/apply/idempotent preview and the packaged read-only cost
repair planner, then starts the migrated application
and requires three consecutive deep health checks. It never stops production.

`--deploy` repeats preparation, stops the old writer, verifies no other container
mounts the live volume, and takes a full offline snapshot. It previews conversion
using the candidate image and the old container's effective timezone and prefix.
Reports are private. Any financially uncertain classification aborts before apply,
even if it might not intersect an active budget: operator review is required, not
automatic disabling of budget admission. There is no override for this policy.

Before invoking apply, restoration intent is durably journaled. The helper checks
original rows, and the workflow checks matching projected totals/digests, source
counts and an unchanged second preview. The candidate starts on Docker's `none`
network, without ingress or provider egress. After full deep readiness, Compose
and the no-rollback commit boundary are made durable; only then is the **same
container** connected to the original network, activating its original loopback
port mapping and restoring provider connectivity. No temporary production proxy,
host firewall changes or elevated capabilities are needed.

Pre-commit failure or interruption stops helpers/candidate and restores the full
snapshot with the old pinned container/image. Post-commit errors never restore
old data: `--recover` retries opening the gate and cleanup. A failure opening
ingress can therefore leave a healthy committed application temporarily offline.
The old image and full snapshot remain retained. Do not run Compose, other
deployers, maintenance writers or the managed updater concurrently. The local
lock does not coordinate external tools; stop all non-container writers yourself.

Readiness checks local CLIProxy/database health, not external provider requests.
The cutover has downtime. No automatic downgrade/replay is supported after ingress
opens. Do not manually overwrite post-upgrade usage with an older snapshot.
