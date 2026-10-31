#!/usr/bin/env python3
"""Machine-local RawRoute deployment. No live changes without --deploy/--recover."""

import argparse
import base64
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from usage_upgrade import convert, convert_codex_credentials


ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / ".local-deploy"
STATE = LOCAL / "state"
PENDING = STATE / "pending.json"
COMPOSE = Path.home() / ".config/ai-personal/rawroute/compose.json"
NAME = "rawroute-rawroute-1"
VOLUME = "rawroute_rawroute-managed-data"
NETWORK = "rawroute_default"
LABEL = "local.rawroute.redeploy"
SNAPSHOT = "cp -a /src/. /dst/ && diff -qr --no-dereference /src /dst"
RESTORE = "find /dst -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && " + SNAPSHOT
HEALTH = """const r = await fetch('http://127.0.0.1:8080/api/health', {signal: AbortSignal.timeout(1500)});
const j = await r.json(); const s = j.dependencies?.storage;
process.exit(r.ok && j.status === 'ok' && j.service === 'rawroute' && j.dependencies?.database === true &&
s && (s.enabled === false || s.enabled === true && s.listening === true) ? 0 : 1);"""


class Failure(Exception):
    pass


class Runner:
    def __init__(self, log=None):
        self.log = log

    def run(self, *args, timeout=60, check=True):
        try:
            result = subprocess.run(args, capture_output=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Failure(f"{args[0]} operation failed or timed out; see private command log.") from error
        if self.log:
            with self.log.open("ab") as stream:
                # Arguments contain paths/IDs only, never literal environment secrets.
                stream.write(("\n$ " + " ".join(args) + "\n").encode())
                stream.write(result.stdout + result.stderr)
        if check and result.returncode:
            raise Failure(f"{args[0]} operation failed (exit {result.returncode}); see private command log.")
        return result

    def text(self, *args, **kwargs):
        return self.run(*args, **kwargs).stdout.decode().strip()

    def inspect(self, resource, kind="container", optional=False):
        result = self.run("docker", kind, "inspect", resource, check=False)
        if result.returncode:
            if optional:
                # Do not mistake a disconnected daemon for a missing container.
                self.run("docker", "info", "--format", "{{.ID}}")
                return None
            raise Failure(f"Cannot inspect {kind} {resource}.")
        return json.loads(result.stdout)[0]


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path, data, mode=0o600):
    if path.is_symlink():
        raise Failure(f"Refusing symlink: {path}")
    descriptor, temporary = tempfile.mkstemp(prefix=".redeploy-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private_directory(path):
    if path.is_symlink():
        raise Failure(f"Refusing symlink: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid():
        raise Failure(f"Recovery directory is not owned by this user: {path}")
    path.chmod(0o700)


def environment(config):
    return dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)


def retired_engine_setting(key):
    return key.startswith(("CLIPROXY_", "CLI_PROXY_")) or key == "MANAGEMENT_PASSWORD"


def deployment_environment(container, old_image, revision):
    current = environment(container["Config"])
    defaults = environment(old_image["Config"])
    overrides = {key: value for key, value in current.items() if defaults.get(key) != value and not retired_engine_setting(key)}
    overrides["DEPLOYMENT_VERSION"] = revision
    if any("\n" in value or "\r" in value or "\0" in value for value in overrides.values()):
        raise Failure("Multiline environment overrides are unsupported; production was not changed.")
    return overrides


def validate_runtime(container, old_image):
    config, host = container["Config"], container["HostConfig"]
    env = environment(config)
    expected = {"SQLITE_PATH": "/data/rawroute.sqlite", "RAWROUTE_DATA_DIR": "/data",
                "PORT": "8080", "HOSTNAME": "0.0.0.0"}
    if any(env.get(key) != value for key, value in expected.items()):
        raise Failure("Unsupported live data paths, backend, or listener; explicit migration required.")
    mounts = container["Mounts"]
    if len(mounts) != 1 or mounts[0].get("Name") != VOLUME or mounts[0]["Destination"] != "/data" or not mounts[0].get("RW") or mounts[0]["Type"] != "volume":
        raise Failure("Expected exactly the canonical writable /data Docker volume.")
    if host["PortBindings"] != {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}:
        raise Failure("Unsupported port mapping; refusing to change exposure.")
    # Docker retains the initial 'none' mode after a validated network connect.
    gated = host["NetworkMode"] == "none" and (config.get("Labels") or {}).get(LABEL)
    if set(container["NetworkSettings"]["Networks"]) != {NETWORK} or (host["NetworkMode"] != NETWORK and not gated):
        raise Failure("Unsupported Docker networking.")
    aliases = container["NetworkSettings"]["Networks"][NETWORK].get("Aliases") or []
    if set(aliases) - {NAME, "rawroute"}:
        raise Failure("Additional network aliases require explicit support.")
    labels = config.get("Labels") or {}
    if labels.get("com.docker.compose.project") != "rawroute" or labels.get("com.docker.compose.service") != "rawroute":
        raise Failure("The live container is not the expected Compose service.")
    for field in ("Cmd", "Entrypoint", "User", "WorkingDir", "StopSignal"):
        if config.get(field) != old_image["Config"].get(field):
            raise Failure(f"Unsupported runtime override: {field}.")
    health = dict(config.get("Healthcheck") or {})
    image_health = dict(old_image["Config"].get("Healthcheck") or {})
    compose_test = ["CMD", "bun", "-e", "fetch('http://127.0.0.1:8080/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    if health.pop("Test", None) not in (image_health.pop("Test", None), compose_test) or health != image_health:
        raise Failure("Unsupported custom healthcheck.")
    if not host.get("Init") or host["RestartPolicy"]["Name"] != "unless-stopped" or config.get("StopTimeout") != 45:
        raise Failure("Unsupported init, restart policy, or shutdown grace period.")
    unsupported = ("Privileged", "ReadonlyRootfs", "AutoRemove", "PublishAllPorts", "CapAdd", "CapDrop", "SecurityOpt",
                   "Devices", "DeviceRequests", "DeviceCgroupRules", "Links", "VolumesFrom", "ExtraHosts", "Dns", "DnsOptions", "DnsSearch",
                   "Ulimits", "Sysctls", "Tmpfs", "Memory", "MemoryReservation", "MemorySwap", "MemorySwappiness", "NanoCpus",
                   "CpuShares", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod", "CpuRealtimeRuntime", "CpusetCpus", "CpusetMems",
                   "PidsLimit", "CgroupParent", "Cgroup", "OomKillDisable", "OomScoreAdj", "PidMode", "UTSMode", "UsernsMode",
                   "StorageOpt", "BlkioWeight", "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps")
    if any(host.get(field) for field in unsupported) or host.get("IpcMode") not in ("", "private") or host.get("ShmSize") != 67108864:
        raise Failure("Unsupported custom Docker isolation/resource settings; refusing a lossy recreation.")


def committed_compose(original, image, revision):
    compose = json.loads(original)
    service = compose["services"]["rawroute"]
    environment = service.setdefault("environment", {})
    if not isinstance(environment, dict):
        raise Failure("Unsupported Compose environment shape; refusing to retain retired engine settings.")
    for key in list(environment):
        if retired_engine_setting(key):
            del environment[key]
    service["image"] = image
    environment["DEPLOYMENT_VERSION"] = revision
    return (json.dumps(compose, indent=2) + "\n").encode()


def source_revision(runner):
    if runner.text("git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=all"):
        raise Failure("Commit or safely set aside source changes first; only clean committed source is deployed.")
    excluded = runner.run("git", "-C", str(ROOT), "check-ignore", "-q", ".local-deploy/redeploy.py", check=False)
    if excluded.returncode:
        raise Failure("Local deployment tooling must be excluded through .git/info/exclude.")
    return runner.text("git", "-C", str(ROOT), "rev-parse", "HEAD")


def healthy(runner, container):
    result = runner.run("docker", "exec", container, "bun", "-e", HEALTH, timeout=5, check=False)
    return result.returncode == 0


def preflight(runner):
    if PENDING.exists():
        raise Failure("An unfinished transaction exists. Run --recover before another deployment.")
    if COMPOSE.is_symlink() or not COMPOSE.is_file():
        raise Failure("Expected a regular installed ai-personal Compose JSON file.")
    context = runner.text("docker", "context", "show")
    server = runner.text("docker", "info", "--format", "{{.ID}}")
    container = runner.inspect(NAME)
    image = runner.inspect(container["Image"], "image")
    validate_runtime(container, image)
    if not container["State"]["Running"] or not healthy(runner, container["Id"]):
        raise Failure("Current production is not deeply healthy; refusing to replace it.")
    capacity = runner.text("docker", "exec", container["Id"], "/bin/sh", "-c", "du -sk /data && df -Pk /data")
    lines = capacity.splitlines()
    used_kib, free_kib = int(lines[0].split()[0]), int(lines[-1].split()[3])
    if free_kib < 2 * used_kib + 2 * 1024 * 1024:
        raise Failure("Insufficient Docker-host free space for a build, snapshot, and rollback reserve.")
    revision = source_revision(runner)
    compose_bytes = COMPOSE.read_bytes()
    compose = json.loads(compose_bytes)
    if set(compose["services"]) != {"rawroute"} or compose["services"]["rawroute"]["volumes"] != ["rawroute-managed-data:/data"]:
        raise Failure("Installed Compose shape has changed; review deployment tooling first.")
    return {"old": container, "old_image": image, "context": context, "server": server, "revision": revision,
            "compose_original": base64.b64encode(compose_bytes).decode(), "compose_mode": stat.S_IMODE(COMPOSE.stat().st_mode)}


@contextlib.contextmanager
def exclusive_lock():
    private_directory(LOCAL)
    private_directory(STATE)
    descriptor = os.open(STATE / "deploy.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("Another local deployment/recovery owns the lock.") from error
        yield
    finally:
        os.close(descriptor)


class Deployment:
    def __init__(self, runner, manifest):
        self.runner, self.m = runner, manifest
        self.directory = STATE / manifest["transaction"]

    def save(self, **changes):
        updated = {**self.m, **changes}
        atomic_write(PENDING, json.dumps(updated, indent=2).encode())
        self.m = updated

    def reconcile_journal(self):
        """Resolve replacement/fsync ambiguity before choosing rollback versus committed cleanup."""
        descriptor = os.open(PENDING, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                persisted = json.load(stream)
            if persisted["transaction"] != self.m["transaction"]:
                raise Failure("Recovery journal identity changed.")
            os.fsync(descriptor)
            sync_directory(STATE)
            self.m = persisted
        finally:
            os.close(descriptor)

    def quiesce_candidate(self):
        """An unresolvable disk error must not leave a candidate accepting more writes."""
        self.verify_daemon()
        original = self.verify_original()
        if original["Name"] == f"/{NAME}":
            return
        candidate = self.owned(NAME)
        if candidate:
            if candidate["Image"] != self.m.get("new_image"):
                raise Failure("Candidate image changed; refusing to stop another deployment.")
            self.runner.run("docker", "update", "--restart=no", candidate["Id"])
            self.runner.run("docker", "stop", "--time", "45", candidate["Id"], timeout=60)
            if self.runner.inspect(candidate["Id"])["State"]["Running"]:
                raise Failure("Cannot confirm that the uncertain candidate stopped.")

    def owned(self, name, kind="container"):
        resource = self.runner.inspect(name, kind, optional=True)
        if resource:
            labels = (resource.get("Config", {}).get("Labels") if kind == "container" else resource.get("Labels")) or {}
            if labels.get(LABEL) != self.m["transaction"]:
                raise Failure(f"Refusing to touch resource not owned by this transaction: {name}.")
        return resource

    def remove_owned_container(self, name):
        resource = self.owned(name)
        if resource:
            self.runner.run("docker", "rm", "--force", resource["Id"])

    def verify_daemon(self):
        if self.runner.text("docker", "context", "show") != self.m["context"] or self.runner.text("docker", "info", "--format", "{{.ID}}") != self.m["server"]:
            raise Failure("Docker context/daemon changed; restore the original connection before recovery.")

    def no_writers(self):
        if self.runner.text("docker", "ps", "-q", "--filter", f"volume={VOLUME}"):
            raise Failure("A running container still mounts live data; refusing snapshot/restore.")

    def copy_volume(self, source, destination, restore=False):
        self.runner.run("docker", "run", "--rm", "--name", self.m["helper"], "--label", f"{LABEL}={self.m['transaction']}",
                        "--network", "none", "--read-only", "--user", "0", "--entrypoint", "/bin/sh",
                        "--mount", f"type=volume,src={source},dst=/src,readonly,volume-nocopy",
                        "--mount", f"type=volume,src={destination},dst=/dst,volume-nocopy",
                        self.m["old"]["Image"], "-c", RESTORE if restore else SNAPSHOT, timeout=300)

    def export_source(self, destination):
        archive = self.runner.run("git", "-C", str(ROOT), "archive", "--format=tar", self.m["revision"]).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            for member in source.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                    raise Failure("Source archive contains unsupported links or special files.")
                if (path.name.startswith(".env") and path.name != ".env.example") or path.suffix == ".pem" or path.name.startswith("service-account") or path.parts[0] in (".git", ".local-deploy", "data", ".rawroute"):
                    raise Failure("Source archive contains a private/runtime path; refusing to build.")
            source.extractall(destination)

    def prepare(self):
        print("Building committed source while production stays online…", flush=True)
        with tempfile.TemporaryDirectory(prefix="rawroute-build-", dir="/tmp/opencode") as directory:
            self.export_source(directory)
            self.runner.run("docker", "build", "--tag", self.m["new_tag"], "--build-arg",
                            f"DEPLOYMENT_VERSION={self.m['revision']}", directory, timeout=1200)
        self.save(new_image=self.runner.inspect(self.m["new_tag"], "image")["Id"])
        # Verify known-good copy tools before beginning any production outage.
        self.runner.run("docker", "run", "--rm", "--name", self.m["helper"], "--label", f"{LABEL}={self.m['transaction']}",
                        "--network", "none", "--read-only", "--user", "0", "--entrypoint", "/bin/sh", self.m["old"]["Image"],
                        "-c", "command -v cp && command -v find && command -v diff && command -v rm")
        self.runner.run("docker", "image", "tag", self.m["old"]["Image"], self.m["rollback_tag"])
        print("Smoke-testing on a fresh isolated volume (no production credentials or network)…", flush=True)
        self.runner.run("docker", "volume", "create", "--label", f"{LABEL}={self.m['transaction']}", self.m["smoke_volume"])
        live_env = environment(self.m["old"]["Config"])
        timezone = live_env.get("TIMEZONE") or "Asia/Jakarta"
        prefix = live_env.get("DATABASE_COLLECTION_PREFIX") or "rawroute"
        fixture = """import {Database} from 'bun:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
const db=new Database('/data/rawroute.sqlite',{create:true});
db.run('CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY,collection_path TEXT NOT NULL,document_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
const c=process.env.DATABASE_COLLECTION_PREFIX.replace(/[^a-zA-Z0-9_-]/g,'_')+'_usage_events';
db.run('INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)',[c+'/fixture',c,'fixture',JSON.stringify({id:'fixture',gatewayKeyId:'fixture',gatewayModelId:'fixture',completedAt:'2026-10-01T00:00:00.000Z',startedAt:'2026-10-01T00:00:00.000Z',status:200,durationMs:0,inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheCreationTokens:0,totalTokens:2,costMicros:1,pricingConfidence:'exact'})]);db.close();
mkdirSync('/data/cliproxy/auth',{recursive:true});
writeFileSync('/data/cliproxy/config.yaml','config-version: 8\\noauth:\\n  auth-dir: "/data/cliproxy/auth"\\n');"""
        self.runner.run("docker", "run", "--rm", "--name", self.m["helper"], "--label", f"{LABEL}={self.m['transaction']}",
                        "--network", "none", "--env", f"DATABASE_COLLECTION_PREFIX={prefix}",
                        "--mount", f"type=volume,src={self.m['smoke_volume']},dst=/data", "--entrypoint", "bun",
                        self.m["new_image"], "-e", fixture)
        convert(self, self.m["smoke_volume"], prefix, timezone, "smoke-usage")
        convert_codex_credentials(self, self.m["smoke_volume"], "smoke-codex-credentials", production=False)
        self.runner.run("docker", "run", "--rm", "--name", self.m["helper"], "--label", f"{LABEL}={self.m['transaction']}",
                        "--network", "none", "--env", f"TIMEZONE={timezone}",
                        "--mount", f"type=volume,src={self.m['smoke_volume']},dst=/data", "--entrypoint", "bun",
                        self.m["new_image"], "run", "--no-env-file", "predict-missing-usage-cost.js",
                        "--sqlite", "/data/rawroute.sqlite", "--timezone", timezone,
                        "--from=2026-10-01T00:00:00.000Z", "--to=2026-10-02T00:00:00.000Z")
        args = ["docker", "create", "--name", self.m["smoke"], "--label", f"{LABEL}={self.m['transaction']}",
                "--init", "--network", "none", "--mount", f"type=volume,src={self.m['smoke_volume']},dst=/data",
                "--env", "SQLITE_PATH=/data/rawroute.sqlite",
                "--env", f"TIMEZONE={timezone}"]
        args += [self.m["new_image"]]
        self.runner.run(*args)
        self.runner.run("docker", "start", self.m["smoke"])
        self.wait_ready(self.m["smoke"], 60)
        self.cleanup_temporary()
        self.save(phase="prepared")

    def cleanup_temporary(self):
        self.remove_owned_container(self.m["helper"])
        self.remove_owned_container(self.m["smoke"])
        if self.owned(self.m["smoke_volume"], "volume"):
            self.runner.run("docker", "volume", "rm", self.m["smoke_volume"])

    def wait_ready(self, container, seconds):
        deadline, consecutive = time.monotonic() + seconds, 0
        while time.monotonic() < deadline:
            status = self.runner.inspect(container)
            if not status["State"]["Running"]:
                raise Failure("Container exited before readiness; private recovery state is retained.")
            consecutive = consecutive + 1 if healthy(self.runner, container) else 0
            if consecutive >= 3:
                return
            time.sleep(1)
        raise Failure(f"Deep readiness did not stabilize within {seconds} seconds.")

    def verify_original(self):
        original = self.runner.inspect(self.m["old"]["Id"])
        if original["Image"] != self.m["old"]["Image"] or original["Name"] not in (f"/{NAME}", f"/{self.m['backup_name']}"):
            raise Failure("Original container identity changed; manual review required.")
        return original

    def create_candidate(self):
        old = self.m["old"]
        env = deployment_environment(old, self.m["old_image"], self.m["revision"])
        env_path = self.directory / "runtime.env"
        atomic_write(env_path, "".join(f"{key}={value}\n" for key, value in sorted(env.items())).encode())
        args = ["docker", "create", "--name", NAME, "--init", "--restart", "unless-stopped", "--stop-timeout", "45",
                "--network", "none", "--publish", "127.0.0.1:8080:8080",
                "--mount", f"type=volume,src={VOLUME},dst=/data,volume-nocopy", "--env-file", str(env_path),
                "--label", f"{LABEL}={self.m['transaction']}"]
        labels = {"com.docker.compose.project": "rawroute", "com.docker.compose.service": "rawroute", "com.docker.compose.container-number": "1", "com.docker.compose.oneoff": "False",
                  "com.docker.compose.project.config_files": str(COMPOSE), "com.docker.compose.project.working_dir": str(COMPOSE.parent),
                  "com.docker.compose.project.environment_file": str(ROOT / ".env.local")}
        for key, value in labels.items():
            args += ["--label", f"{key}={value}"]
        logs = old["HostConfig"]["LogConfig"]
        args += ["--log-driver", logs["Type"]]
        for key, value in logs.get("Config", {}).items():
            args += ["--log-opt", f"{key}={value}"]
        args.append(self.m["new_image"])
        self.save(phase="create-intent")
        candidate = self.runner.text(*args)
        self.save(candidate=candidate, phase="candidate-created")

    def cutover(self):
        self.verify_daemon()
        current = self.runner.inspect(NAME)
        if current != self.m["old"]:
            # Inspect includes naturally changing counters/timestamps. Compare deployment configuration instead.
            for key in ("Id", "Image", "Config", "HostConfig", "Mounts"):
                if current.get(key) != self.m["old"].get(key):
                    raise Failure("Production changed during preparation; refusing cutover.")
        if not current["State"]["Running"] or not healthy(self.runner, current["Id"]):
            raise Failure("Production became unhealthy during preparation.")
        if COMPOSE.read_bytes() != base64.b64decode(self.m["compose_original"]):
            raise Failure("Installed Compose changed during preparation; refusing cutover.")
        if source_revision(self.runner) != self.m["revision"]:
            raise Failure("Source changed during preparation; refusing cutover.")
        # Prepare/label backup before downtime. No live volume access until the old writer stops.
        self.runner.run("docker", "volume", "create", "--label", f"{LABEL}={self.m['transaction']}", self.m["backup_volume"])
        self.save(phase="stop-intent", outage_started=time.time())
        print("Preparation passed. Gracefully stopping production and taking an offline snapshot…", flush=True)
        self.runner.run("docker", "stop", "--time", "45", self.m["old"]["Id"], timeout=60)
        stopped = self.verify_original()
        if stopped["State"]["Running"] or stopped["State"].get("ExitCode") == 137:
            raise Failure("Production did not shut down cleanly; refusing to deploy.")
        self.no_writers()
        self.save(phase="snapshot-intent")
        self.copy_volume(VOLUME, self.m["backup_volume"])
        self.save(snapshot_complete=True, phase="snapshot-ready")
        env = environment(self.m["old"]["Config"])
        convert(self, VOLUME, env.get("DATABASE_COLLECTION_PREFIX") or "rawroute", env.get("TIMEZONE") or "Asia/Jakarta")
        convert_codex_credentials(self, VOLUME)
        self.save(phase="rename-intent")
        self.runner.run("docker", "rename", self.m["old"]["Id"], self.m["backup_name"])
        self.save(phase="old-renamed")
        self.create_candidate()
        isolated = self.runner.inspect(self.m["candidate"])
        if set(isolated["NetworkSettings"]["Networks"]) != {"none"}:
            raise Failure("Candidate ingress isolation could not be confirmed.")
        self.save(candidate_may_write=True, phase="start-intent")
        self.runner.run("docker", "start", self.m["candidate"])
        self.save(phase="validating")
        self.wait_ready(self.m["candidate"], self.m["ready_timeout"])
        updated = committed_compose(base64.b64decode(self.m["compose_original"]), self.m["new_tag"], self.m["revision"])
        self.save(phase="compose-intent", compose_updated=base64.b64encode(updated).decode())
        if COMPOSE.read_bytes() != base64.b64decode(self.m["compose_original"]):
            raise Failure("Compose changed concurrently; rollback will not overwrite unknown edits.")
        atomic_write(COMPOSE, updated, self.m["compose_mode"])
        # From this durable boundary onward, cleanup failure must NEVER roll back production writes.
        self.save(phase="committed")
        print("New deployment passed readiness. Finalizing recovery records…", flush=True)
        self.finish_committed()

    def restore_compose(self):
        original = base64.b64decode(self.m["compose_original"])
        current = COMPOSE.read_bytes()
        if current == original:
            return
        if current != base64.b64decode(self.m.get("compose_updated", "")):
            raise Failure("Installed Compose was edited independently; refusing to overwrite it.")
        atomic_write(COMPOSE, original, self.m["compose_mode"])

    def rollback(self):
        print("Deployment failed; recovering the previous container and pre-cutover data…", flush=True)
        self.verify_daemon()
        self.cleanup_temporary()
        original = self.verify_original()
        candidate = self.owned(NAME) if original["Name"] != f"/{NAME}" else None
        if candidate:
            if candidate["Image"] != self.m.get("new_image") or (self.m.get("candidate") and candidate["Id"] != self.m["candidate"]):
                raise Failure("Candidate identity changed; manual review required.")
            self.runner.run("docker", "update", "--restart=no", candidate["Id"])
            self.runner.run("docker", "stop", "--time", "45", candidate["Id"], timeout=60)
            if self.runner.inspect(candidate["Id"])["State"]["Running"]:
                raise Failure("Candidate is still running; refusing data restoration.")
            self.runner.run("docker", "rm", candidate["Id"])
        if (self.m.get("candidate_may_write") or self.m.get("data_may_changed")) and not self.m.get("data_restored"):
            if not self.m.get("snapshot_complete") or not self.owned(self.m["backup_volume"], "volume"):
                raise Failure("No complete owned snapshot; refusing to start the old binary against uncertain data.")
            self.no_writers()
            self.save(phase="restore-intent")
            self.copy_volume(self.m["backup_volume"], VOLUME, restore=True)
            self.save(data_restored=True, phase="data-restored")
        self.restore_compose()
        original = self.verify_original()
        if original["Name"] != f"/{NAME}":
            self.save(phase="rename-back-intent")
            self.runner.run("docker", "rename", original["Id"], NAME)
        if not original["State"]["Running"]:
            self.save(phase="restart-old-intent")
            self.runner.run("docker", "start", original["Id"])
        self.wait_ready(original["Id"], 30)
        self.save(phase="rolled-back")
        self.archive()
        print("Previous deployment is healthy again. The redeploy failed; recovery artifacts are retained.", flush=True)

    def finish_committed(self):
        candidate = self.owned(NAME)
        if not candidate or candidate["Id"] != self.m["candidate"]:
            raise Failure("Committed deployment needs attention; automatic snapshot rollback is no longer safe.")
        if self.m.get("resume_candidate") or (not candidate["State"]["Running"] and candidate["HostConfig"]["RestartPolicy"]["Name"] == "no"):
            # Intent survives failure between changing restart policy and starting the container.
            self.save(resume_candidate=True)
            if not candidate["State"]["Running"]:
                self.runner.run("docker", "update", "--restart=unless-stopped", candidate["Id"])
                self.runner.run("docker", "start", candidate["Id"])
            self.wait_ready(candidate["Id"], self.m["ready_timeout"])
            self.save(resume_candidate=False)
        if not healthy(self.runner, candidate["Id"]):
            raise Failure("Committed deployment needs attention; automatic snapshot rollback is no longer safe.")
        # Opening ingress is strictly after the durable no-rollback boundary.
        networks = self.runner.inspect(candidate["Id"])["NetworkSettings"]["Networks"]
        if "none" in networks:
            self.runner.run("docker", "network", "disconnect", "none", candidate["Id"])
        if NETWORK not in networks:
            self.runner.run("docker", "network", "connect", "--alias", "rawroute", NETWORK, candidate["Id"])
        original = self.runner.inspect(self.m["old"]["Id"], optional=True)
        if original:
            self.verify_original()
            if original["State"]["Running"]:
                raise Failure("Old container unexpectedly running; refusing cleanup.")
            self.runner.run("docker", "rm", original["Id"])
        self.archive()
        print(f"Deployed {self.m['revision'][:12]}. Old image and offline data snapshot retained.", flush=True)

    def archive(self):
        atomic_write(self.directory / "manifest.json", json.dumps(self.m, indent=2).encode())
        PENDING.unlink()
        sync_directory(STATE)


def begin(runner, facts, ready_timeout):
    transaction = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(4)
    directory = STATE / transaction
    private_directory(directory)
    log = directory / "commands.log"
    atomic_write(log, b"")
    runner.log = log
    manifest = {**facts, "transaction": transaction, "phase": "preparing", "ready_timeout": ready_timeout,
                "new_tag": f"rawroute:local-{facts['revision'][:12]}-{transaction.lower()}",
                "rollback_tag": f"rawroute:rollback-{transaction.lower()}", "backup_name": f"rawroute-old-{transaction.lower()}",
                "backup_volume": f"rawroute-backup-{transaction.lower()}", "smoke": f"rawroute-smoke-{transaction.lower()}",
                "smoke_volume": f"rawroute-smoke-{transaction.lower()}", "helper": f"rawroute-helper-{transaction.lower()}"}
    deployment = Deployment(runner, manifest)
    deployment.save()
    return deployment


def interrupted(number, _frame):
    raise Failure(f"Interrupted by signal {number}; attempting pre-commit recovery.")


def run_transaction(deployment, prepare_only=False):
    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, interrupted)
    try:
        deployment.prepare()
        if prepare_only:
            deployment.save(phase="prepared-only")
            deployment.archive()
            print("Build and isolated smoke passed. Production was not changed.")
        else:
            deployment.cutover()
        return 0
    except BaseException as error:
        # A second terminal signal must not interrupt rollback halfway through data restoration.
        for number in (signal.SIGINT, signal.SIGTERM):
            signal.signal(number, signal.SIG_IGN)
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        if deployment.m["phase"] != "committed":
            try:
                deployment.reconcile_journal()
            except BaseException as journal_error:
                print(f"Cannot establish durable recovery state: {journal_error}", file=sys.stderr)
                try:
                    deployment.quiesce_candidate()
                except BaseException as stop_error:
                    print(f"Cannot confirm candidate shutdown: {stop_error}", file=sys.stderr)
                print("Do not restore data manually. Fix journal storage/Docker access, then run --recover.", file=sys.stderr)
                return 1
        if deployment.m["phase"] == "committed":
            print("Deployment committed. Run --recover to retry cleanup; data will NOT be rolled back.", file=sys.stderr)
            return 1
        try:
            deployment.rollback()
        except BaseException as recovery_error:
            print(f"Recovery incomplete: {recovery_error}\nKeep recovery files and backup volume. Run --recover after resolving the error.", file=sys.stderr)
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true", help="read-only preflight (default)")
    modes.add_argument("--prepare", action="store_true", help="build and isolated smoke only; never stop production")
    modes.add_argument("--deploy", action="store_true", help="build, smoke, cut over, automatically recover pre-commit failures")
    modes.add_argument("--recover", action="store_true", help="recover unfinished transaction; committed transactions only retry cleanup")
    parser.add_argument("--ready-timeout", type=int, default=25, help="candidate deep readiness window, 5–120 seconds (default 25)")
    args = parser.parse_args()
    if not 5 <= args.ready_timeout <= 120:
        parser.error("--ready-timeout must be between 5 and 120")
    os.umask(0o077)
    runner = Runner()
    if not (args.prepare or args.deploy or args.recover):
        facts = preflight(runner)
        print(f"Read-only preflight passed: {NAME}, committed source {facts['revision'][:12]}, canonical SQLite volume, deep health OK.")
        print("No production change. --prepare builds/smokes only; --deploy performs the cutover. Do not run ai-personal-update/chezmoi concurrently.")
        return 0
    with exclusive_lock():
        if args.recover:
            if not PENDING.exists():
                print("No unfinished transaction. Nothing changed.")
                return 0
            manifest = json.loads(PENDING.read_bytes())
            if not re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{8}", manifest["transaction"]):
                raise Failure("Invalid private recovery journal.")
            runner.log = STATE / manifest["transaction"] / "commands.log"
            deployment = Deployment(runner, manifest)
            deployment.reconcile_journal()
            deployment.verify_daemon()
            for number in (signal.SIGINT, signal.SIGTERM):
                signal.signal(number, signal.SIG_IGN)
            if deployment.m["phase"] == "committed":
                deployment.finish_committed()
            else:
                deployment.rollback()
            return 0
        return run_transaction(begin(runner, preflight(runner), args.ready_timeout), prepare_only=args.prepare)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Failure, OSError, ValueError, KeyError) as error:
        print(f"Redeploy refused/incomplete: {error}", file=sys.stderr)
        raise SystemExit(1)
