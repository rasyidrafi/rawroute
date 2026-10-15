"""Offline candidate-image conversion used by the machine-local deploy transaction."""

import json
import os


def convert(deployment, volume, prefix, timezone, report_name="usage"):
    """Caller must stop writers and durably record restoration intent before apply."""
    d = deployment
    from_path = "/data/rawroute.sqlite"

    def invoke(name, apply=False):
        args = ["docker", "run", "--rm", "--name", d.m["helper"], "--label",
                f"local.rawroute.redeploy={d.m['transaction']}", "--network", "none",
                "--env", f"DATABASE_COLLECTION_PREFIX={prefix}", "--env", f"TIMEZONE={timezone}",
                "--mount", f"type=volume,src={volume},dst=/data,volume-nocopy",
                "--entrypoint", "bun", d.m["new_image"], "run", "--no-env-file",
                "migrations/usage-projection.js", "--sqlite", from_path, "--timezone", timezone]
        if apply:
            args += ["--apply", "--writers-stopped", "--backup", f"/data/.usage-before-{d.m['transaction']}.sqlite"]
        result = d.runner.run(*args, timeout=300)
        # Directory and umask are private; reports never go to the terminal.
        path = d.directory / f"{report_name}-{name}.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(result.stdout)
        return json.loads(result.stdout)

    before = invoke("preview")
    # Conservative admission: even uncertainty outside active budgets needs review.
    # Never silently deploy a conversion which could disable budget admission.
    if any(row["financialState"] != "known" for row in before["classifications"]):
        raise ValueError("Financially uncertain history requires offline operator review; private report retained")
    if report_name == "usage":
        d.save(data_may_changed=True, phase="migration-intent")
    applied = invoke("apply", True)
    after = invoke("validated")
    if not after["unchanged"] or after["copiedRawDocuments"] != 0:
        raise ValueError("Migration second preview is not an idempotent no-op")
    for key in ("plannedDigest", "rawDocuments", "buckets", "workspaceTotals", "workspaceDailySums"):
        if before[key] != applied[key] or applied[key] != after[key]:
            raise ValueError(f"Migration validation mismatch: {key}")
    if after["sourceDocuments"] != before["sourceDocuments"] + before["copiedRawDocuments"]:
        raise ValueError("Migration source count changed unexpectedly")
    if not before["copiedRawDocuments"] and before["sourceDigest"] != after["sourceDigest"]:
        raise ValueError("Migration source digest changed unexpectedly")
    return after
