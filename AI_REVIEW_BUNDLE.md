# AI Review Bundle

`prepare_ai_review_bundle.py` creates a secret-scanned source ZIP, review template,
manifest, and SHA-256 checksum file. Python 3.10+ is required. Source-only mode does
not need Docker, network access, or package installation.

The source ZIP excludes `.git`, `node_modules`, build output, caches, local environment
files, database dumps, and probable credentials. Secret scanning is heuristic; manually
review the archive and complete `AI_REVIEW_CONTEXT.md` before uploading it.

## macOS and Linux

```sh
python3 prepare_ai_review_bundle.py . --output-dir ./ai-review-output
python3 prepare_ai_review_bundle.py . --output-dir ./ai-review-output --dry-run
```

Use compatible existing Linux x64 Node 22 dependencies only when they are known-good:

```sh
python3 prepare_ai_review_bundle.py . --include-dependencies --dependency-source existing
```

Prefer Docker-built dependencies for builds, tests, or benchmarks in an offline Linux
x64 Node 22 receiver:

```sh
python3 prepare_ai_review_bundle.py . \
  --output-dir ./ai-review-output \
  --include-dependencies \
  --dependency-source docker \
  --target-node-version 22.16.0
```

Lifecycle scripts are disabled by default. Enable them only when native binaries or
generated clients require them; package installation can execute arbitrary code:

```sh
python3 prepare_ai_review_bundle.py . \
  --include-dependencies \
  --dependency-source docker \
  --install-scripts \
  --run-verification
```

Git history is separate because deleted or historical commits may contain secrets:

```sh
python3 prepare_ai_review_bundle.py . --include-git-history
```

## Windows PowerShell

```powershell
py -3 .\prepare_ai_review_bundle.py . --output-dir .\ai-review-output
py -3 .\prepare_ai_review_bundle.py . --output-dir .\ai-review-output --dry-run
```

Source-only packaging works natively. Use Docker Desktop or WSL for Linux dependency
generation. Do not package Windows `node_modules` as Linux-compatible dependencies.

## WSL

Run the Linux examples from the WSL filesystem. Docker dependency preparation requires
Docker Desktop WSL integration or a Docker Engine reachable from WSL.

## Review Context

Complete the generated review template with the goal, required deliverable, priority
areas, deployment CPU/RAM, concurrency, database size, slow endpoints, measured latency,
commands, compatibility constraints, behavior that must not change, and sanitized test
fixtures. Confirm that credentials and production personal data were removed.

Verify checksums with `sha256sum -c rawroute-checksums.sha256` on Linux/WSL. On
PowerShell, compare each entry with `Get-FileHash -Algorithm SHA256`.
