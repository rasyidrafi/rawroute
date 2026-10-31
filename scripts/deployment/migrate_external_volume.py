#!/usr/bin/env python3
"""Copy an old external-Compose volume and migrate its Codex credentials offline."""

import argparse
import json
import os
import secrets
import subprocess
import sys


PROJECT_LABEL = "com.docker.compose.project"
VOLUME_LABEL = "com.docker.compose.volume"
MIGRATION_LABEL = "local.rawroute.external-volume-migration"
AUTH_MOUNT = "/root/.cli-proxy-api"
CONFIG_MOUNT = "/legacy/cliproxy-config.yaml"
AUTH_SERVICE = "cli-proxy-api"


class Failure(Exception):
    pass


class Runner:
    def run(self, *args, check=True, timeout=None):
        try:
            result = subprocess.run(args, capture_output=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Failure("Docker operation failed; the source volume was not modified.") from error
        if check and result.returncode:
            raise Failure(f"{args[0]} operation failed (exit {result.returncode}).")
        return result


def inspect(runner, kind, resource, optional=False):
    result = runner.run("docker", kind, "inspect", resource, check=False)
    if result.returncode:
        if optional:
            # Distinguish an absent volume from a disconnected Docker daemon.
            runner.run("docker", "info", "--format", "{{.ID}}")
            return None
        raise Failure(f"Cannot inspect {kind} {resource}.")
    try:
        return json.loads(result.stdout)[0]
    except (IndexError, json.JSONDecodeError) as error:
        raise Failure(f"Docker returned invalid inspect data for {kind} {resource}.") from error


def _bind_source(container, destination, label):
    mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == destination]
    if len(mounts) != 1 or mounts[0].get("Type") != "bind":
        raise Failure(f"Expected one old Compose bind mount for {label} at {destination}.")
    source = mounts[0].get("Source")
    if not isinstance(source, str) or not os.path.isabs(source) or "," in source:
        raise Failure(f"The inspected old Compose source for {label} is not a safe absolute path.")
    return source


def _public_plan(plan):
    return {key: value for key, value in plan.items() if key not in ("authSource", "configSource")}


def migration_plan(runner, container_name, engine_container_name, new_image):
    container = inspect(runner, "container", container_name)
    labels = (container.get("Config") or {}).get("Labels") or {}
    project = labels.get(PROJECT_LABEL)
    if labels.get("com.docker.compose.service") != "rawroute" or not project:
        raise Failure("The container is not a labeled RawRoute Compose service.")
    mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == "/data"]
    if len(mounts) != 1 or mounts[0].get("Type") != "volume" or not mounts[0].get("RW"):
        raise Failure("Expected one writable Docker volume mounted at /data.")
    source = mounts[0].get("Name")
    if not source:
        raise Failure("The existing /data volume has no Docker volume name.")
    source_volume = inspect(runner, "volume", source)
    source_labels = source_volume.get("Labels") or {}
    if source_labels.get(PROJECT_LABEL) != project or source_labels.get(VOLUME_LABEL) != "rawroute-data":
        raise Failure("The source is not the old rawroute-data volume for this Compose project.")
    destination = f"{project}_rawroute-managed-data"
    if destination == source:
        raise Failure("Source and canonical data volumes must be different.")
    if inspect(runner, "volume", destination, optional=True):
        raise Failure(f"Canonical volume already exists: {destination}; refusing to overwrite it.")
    image = container.get("Image")
    if not image:
        raise Failure("The old RawRoute image identity is unavailable.")
    rollback_tag = f"rawroute:external-rollback-{image.removeprefix('sha256:')[:12]}"
    engine = inspect(runner, "container", engine_container_name)
    engine_labels = (engine.get("Config") or {}).get("Labels") or {}
    if engine_labels.get(PROJECT_LABEL) != project or engine_labels.get("com.docker.compose.service") != AUTH_SERVICE:
        raise Failure("The CLIProxy container is not the matching service in this Compose project.")
    auth_source = _bind_source(engine, AUTH_MOUNT, "CLIProxy auth directory")
    config_source = _bind_source(engine, "/CLIProxyAPI/config.yaml", "CLIProxy config")
    candidate_image = inspect(runner, "image", new_image)
    candidate_image_id = candidate_image.get("Id")
    if not candidate_image_id:
        raise Failure("The selected new RawRoute image identity is unavailable; pull it before migration.")
    candidate_tag = f"rawroute:external-upgrade-{candidate_image_id.removeprefix('sha256:')[:12]}"
    existing_candidate_tag = inspect(runner, "image", candidate_tag, optional=True)
    if existing_candidate_tag and existing_candidate_tag.get("Id") != candidate_image_id:
        raise Failure("The pinned upgrade image tag already refers to a different image.")
    return {
        "project": project,
        "container": container.get("Id", container_name),
        "engineContainer": engine.get("Id", engine_container_name),
        "sourceVolume": source,
        "destinationVolume": destination,
        "oldImage": image,
        "rollbackImage": rollback_tag,
        "newImage": candidate_image_id,
        "newImageTag": candidate_tag,
        "authSource": auth_source,
        "configSource": config_source,
    }, container, engine


def _assert_no_writers(runner, volume):
    result = runner.run("docker", "ps", "-q", "--filter", f"volume={volume}")
    if result.stdout.strip():
        raise Failure(f"A running container still uses {volume}; stop the old Compose stack first.")


def _codex_migration(runner, plan, volume, *, read_only=False, apply=False, backup_dir=None):
    # CLIProxy ran as uid 0; Bun's homedir() must resolve v8's ~/.cli-proxy-api to /root.
    args = ["docker", "run", "--rm", "--network", "none", "--user", "0:0",
            "--env", "HOME=/root",
            "--mount", f"type=volume,src={volume},dst=/data,volume-nocopy" + (",readonly" if read_only else ""),
            "--mount", f"type=bind,src={plan['authSource']},dst={AUTH_MOUNT},readonly",
            "--mount", f"type=bind,src={plan['configSource']},dst={CONFIG_MOUNT},readonly",
            "--entrypoint", "bun", plan["newImage"], "run", "--no-env-file",
            "migrations/codex-credentials.js", "--sqlite", "/data/rawroute.sqlite",
            "--auth-dir", AUTH_MOUNT, "--config", CONFIG_MOUNT]
    if apply:
        args += ["--apply", "--writers-stopped", "--backup-dir", backup_dir]
    result = runner.run(*args, timeout=300)
    try:
        return json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise Failure("The offline Codex credential importer returned invalid results.") from error


def _migration_summary(result):
    if not isinstance(result, dict):
        raise Failure("The offline Codex credential importer returned an invalid report.")
    for field in ("required", "accounts", "resetRecords"):
        if field not in result:
            raise Failure("The offline Codex credential importer returned an incomplete preview.")
    if type(result["required"]) is not bool or any(
        type(result[field]) is not int or result[field] < 0 for field in ("accounts", "resetRecords")
    ):
        raise Failure("The offline Codex credential importer returned invalid counts.")
    return {field: result[field] for field in ("required", "accounts", "resetRecords")}


def import_external_credentials(runner, plan, before, backup_dir):
    before = _migration_summary(before)
    if not before.get("required"):
        return before, None
    destination_preview = _migration_summary(_codex_migration(
        runner, plan, plan["destinationVolume"], read_only=True))
    if destination_preview != before:
        raise Failure("The copied database/auth inputs differ from the stopped-source preview; do not start the new app.")
    applied = _codex_migration(runner, plan, plan["destinationVolume"], apply=True, backup_dir=backup_dir)
    after = _migration_summary(_codex_migration(
        runner, plan, plan["destinationVolume"], read_only=True))
    if (not isinstance(applied, dict) or applied.get("applied") is not True or applied.get("required") is not False
            or applied.get("accounts") != before.get("accounts")
            or applied.get("resetRecords") != before.get("resetRecords")
            or applied.get("backup") != backup_dir):
        raise Failure("Codex credential conversion did not match its preview; do not start the new app.")
    if after.get("required") or after.get("accounts") or after.get("resetRecords"):
        raise Failure("Codex credential conversion is not an idempotent no-op; do not start the new app.")
    return after, backup_dir


def migrate_external_volume(runner, container_name, engine_container_name, new_image, *, apply=False, writers_stopped=False):
    plan, container, engine = migration_plan(runner, container_name, engine_container_name, new_image)
    if apply and not writers_stopped:
        raise Failure("Stop RawRoute, the external engine, and all SQLite writers; pass --writers-stopped before --apply.")
    if (container.get("State") or {}).get("Running"):
        raise Failure("Stop the old RawRoute container before previewing or applying this migration.")
    if (engine.get("State") or {}).get("Running"):
        raise Failure("Stop the old CLIProxy container before previewing or applying this migration.")
    _assert_no_writers(runner, plan["sourceVolume"])
    _assert_no_writers(runner, plan["destinationVolume"])
    source_preview = _migration_summary(_codex_migration(
        runner, plan, plan["sourceVolume"], read_only=True))
    if not apply:
        return {"applied": False, **_public_plan(plan), "credentialMigration": source_preview}

    old_image_id = runner.run("docker", "image", "inspect", "--format", "{{.Id}}", plan["oldImage"]).stdout.decode().strip()
    if old_image_id != plan["oldImage"]:
        raise Failure("The old RawRoute image identity changed; refusing to create a rollback tag.")
    rollback_image = inspect(runner, "image", plan["rollbackImage"], optional=True)
    if rollback_image and rollback_image.get("Id") != plan["oldImage"]:
        raise Failure("The rollback image tag already refers to a different image.")
    if not rollback_image:
        runner.run("docker", "image", "tag", plan["oldImage"], plan["rollbackImage"])
    candidate_tag = inspect(runner, "image", plan["newImageTag"], optional=True)
    if candidate_tag and candidate_tag.get("Id") != plan["newImage"]:
        raise Failure("The pinned upgrade image tag changed; refusing to overwrite it.")
    if not candidate_tag:
        runner.run("docker", "image", "tag", plan["newImage"], plan["newImageTag"])

    # Use the stopped application image as an offline copy helper; no engine image or network is needed.
    runner.run("docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0",
               "--entrypoint", "/bin/sh", plan["oldImage"], "-ec",
               "command -v cp && command -v find && command -v diff")
    token = secrets.token_hex(8)
    runner.run("docker", "volume", "create", "--label", f"{PROJECT_LABEL}={plan['project']}",
               "--label", f"{VOLUME_LABEL}=rawroute-managed-data",
               "--label", f"{MIGRATION_LABEL}={token}", plan["destinationVolume"])
    destination = inspect(runner, "volume", plan["destinationVolume"])
    destination_labels = destination.get("Labels") or {}
    if destination_labels.get(MIGRATION_LABEL) != token:
        raise Failure("The canonical volume was created concurrently; the original volume remains untouched.")
    command = "test -z \"$(find /dst -mindepth 1 -maxdepth 1 -print -quit)\" && cp -a /src/. /dst/ && diff -qr --no-dereference /src /dst"
    try:
        _assert_no_writers(runner, plan["sourceVolume"])
        _assert_no_writers(runner, plan["destinationVolume"])
        runner.run("docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0",
                   "--entrypoint", "/bin/sh",
                   "--mount", f"type=volume,src={plan['sourceVolume']},dst=/src,readonly,volume-nocopy",
                   "--mount", f"type=volume,src={plan['destinationVolume']},dst=/dst,volume-nocopy",
                   plan["oldImage"], "-ec", command)
    except Failure as error:
        raise Failure(f"Copy failed; {plan['sourceVolume']} and {plan['rollbackImage']} remain intact. Do not start from {plan['destinationVolume']}; verify it has no users, remove that partial volume, then retry.") from error
    current_engine = inspect(runner, "container", plan["engineContainer"])
    if (current_engine.get("State") or {}).get("Running"):
        raise Failure("The old CLIProxy container restarted during migration; the source volume and auth files remain untouched.")
    _assert_no_writers(runner, plan["sourceVolume"])
    _assert_no_writers(runner, plan["destinationVolume"])
    backup_dir = f"/data/.codex-before-external-migration-{secrets.token_hex(8)}"
    try:
        _, credential_backup = import_external_credentials(runner, plan, source_preview, backup_dir)
    except Failure as error:
        raise Failure(f"Offline Codex conversion failed; {plan['sourceVolume']}, {plan['rollbackImage']}, and the read-only auth/config sources remain intact. Do not start the new app. Remove only the unused destination volume after verifying it has no users, then retry or recover from the retained source.") from error
    result = {
        "applied": True,
        **_public_plan(plan),
        "credentialMigration": {
            **source_preview,
            "required": False,
            "applied": source_preview["required"],
        },
    }
    if credential_backup:
        result["credentialBackup"] = credential_backup
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True, help="stopped RawRoute container from the old external Compose project")
    parser.add_argument("--engine-container", required=True, help="stopped CLIProxy container from the same Compose project")
    parser.add_argument("--new-image", required=True, help="locally pulled new RawRoute image containing the offline importer")
    parser.add_argument("--apply", action="store_true", help="copy the old volume to the canonical volume")
    parser.add_argument("--writers-stopped", action="store_true", help="confirm the old app, external engine, and SQLite writers are stopped")
    args = parser.parse_args()
    if args.writers_stopped and not args.apply:
        parser.error("--writers-stopped requires --apply")
    try:
        print(json.dumps(migrate_external_volume(Runner(), args.container, args.engine_container, args.new_image, apply=args.apply,
                                                 writers_stopped=args.writers_stopped), indent=2))
    except Failure as error:
        print(f"External volume migration refused/incomplete: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
