"""Local redeploy tests. Real Docker copy test requires RAWROUTE_TEST_DOCKER=1."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("redeploy", Path(__file__).with_name("redeploy.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class FakeRunner:
    def __init__(self):
        self.log = None
        self.calls = []
        self.fail = None
        self.data = {"database": "before", "credential": "secret"}
        self.snapshot = None
        self.containers = {"old-id": {"Id": "old-id", "Image": "old-image", "Name": "/" + r.NAME,
                           "Config": {"Env": ["PORT=8080"], "Labels": {}}, "HostConfig": {"LogConfig": {"Type": "local", "Config": {}}},
                           "Mounts": [], "State": {"Running": True, "ExitCode": 0}}}
        self.volumes = {}

    def inspect(self, name, kind="container", optional=False):
        if kind == "volume":
            value = self.volumes.get(name)
        else:
            value = next((value for value in self.containers.values() if name in (value["Id"], value["Name"].lstrip("/"))), None)
        if value is None and not optional:
            raise r.Failure("Missing test resource")
        return copy.deepcopy(value)

    def run(self, *args, **_kwargs):
        self.calls.append(args)
        operation = args[1] if args[0] == "docker" else args[0]
        if self.fail == operation:
            self.fail = None
            raise r.Failure("Injected " + operation + " failure")
        output = b""
        if operation == "stop":
            self.containers[args[-1]]["State"]["Running"] = False
        elif operation == "start":
            container = self.containers[args[-1]]
            container["State"]["Running"] = True
            if container["Id"] == "new-id":
                self.data.update(database="after migration", new_file="candidate only")
        elif operation == "rename":
            self.containers[args[-2]]["Name"] = "/" + args[-1]
        elif operation == "rm":
            del self.containers[args[-1]]
        elif operation == "update":
            policy = args[2].split("=", 1)[1]
            self.containers[args[-1]]["HostConfig"]["RestartPolicy"]["Name"] = policy
        elif operation == "volume" and args[2] == "create":
            label = args[args.index("--label") + 1].split("=", 1)[1]
            self.volumes[args[-1]] = {"Labels": {r.LABEL: label}}
        elif operation == "create":
            label = next(args[index + 1].split("=", 1)[1] for index, value in enumerate(args) if value == "--label" and args[index + 1].startswith(r.LABEL + "="))
            self.containers["new-id"] = {"Id": "new-id", "Image": "new-image", "Name": "/" + args[args.index("--name") + 1],
                                         "Config": {"Labels": {r.LABEL: label}}, "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}}, "NetworkSettings": {"Networks": {"none": {}}}, "State": {"Running": False}}
            output = b"new-id\n"
        return subprocess.CompletedProcess(args, 0, output, b"")

    def text(self, *args, **kwargs):
        if args[:3] == ("docker", "context", "show"):
            return "default"
        if args[:2] == ("docker", "info"):
            return "server-id"
        if args[:3] == ("docker", "ps", "-q"):
            return "\n".join(container["Id"] for container in self.containers.values() if container["State"]["Running"])
        return self.run(*args, **kwargs).stdout.decode().strip()


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        directory = Path(self.temporary.name)
        self.compose = directory / "compose.json"
        self.compose.write_text(json.dumps({"services": {"rawroute": {"image": "old", "environment": {}}}}))
        self.original_compose = self.compose.read_bytes()
        for name, value in (("STATE", directory), ("PENDING", directory / "pending.json"), ("COMPOSE", self.compose)):
            patcher = patch.object(r, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (("healthy", lambda *_: True), ("source_revision", lambda *_: "abc123")):
            patcher = patch.object(r, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.runner = FakeRunner()
        facts = {"old": self.runner.inspect("old-id"), "old_image": {"Config": {"Env": ["PORT=8080"]}},
                 "context": "default", "server": "server-id", "revision": "abc123", "compose_mode": 0o600,
                 "compose_original": r.base64.b64encode(self.original_compose).decode()}
        self.deployment = r.begin(self.runner, facts, 5)
        self.deployment.save(new_image="new-image")
        self.deployment.prepare = lambda: None
        self.deployment.wait_ready = lambda *_: None
        self.deployment.copy_volume = self.copy_volume
        patcher = patch.object(r, "convert", lambda *_: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def copy_volume(self, _source, _destination, restore=False):
        self.runner.calls.append(("copy", "restore" if restore else "snapshot"))
        if restore:
            self.runner.data = copy.deepcopy(self.runner.snapshot)
        else:
            self.runner.snapshot = copy.deepcopy(self.runner.data)

    def assert_recovered(self):
        old = self.runner.inspect("old-id")
        self.assertEqual(old["Name"], "/" + r.NAME)
        self.assertTrue(old["State"]["Running"])
        self.assertEqual(self.runner.data, {"database": "before", "credential": "secret"})
        self.assertEqual(self.compose.read_bytes(), self.original_compose)
        self.assertFalse(r.PENDING.exists())

    def test_build_failure_does_not_stop_production(self):
        def fail():
            raise r.Failure("Build failed")
        self.deployment.prepare = fail
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertFalse(any(call[:2] == ("docker", "stop") for call in self.runner.calls))
        self.assert_recovered()

    def test_prepare_only_never_cuts_over(self):
        self.assertEqual(r.run_transaction(self.deployment, prepare_only=True), 0)
        self.assertFalse(any(call[:2] == ("docker", "stop") for call in self.runner.calls))
        self.assert_recovered()

    def test_stop_failure_preserves_old_data(self):
        self.runner.fail = "stop"
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()

    def test_incomplete_snapshot_is_not_restored(self):
        def fail(*_args, **_kwargs):
            raise r.Failure("Copy failed")
        self.deployment.copy_volume = fail
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()
        self.assertNotIn(("copy", "restore"), self.runner.calls)

    def test_create_failure_restores_name(self):
        self.runner.fail = "create"
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()

    def migration_failure(self, interrupt):
        def migrate(deployment, *_):
            deployment.save(data_may_changed=True, phase="migration-intent")
            self.runner.data["database"] = "partially migrated"
            if interrupt:
                r.interrupted(r.signal.SIGTERM, None)
            raise r.Failure("Migration failed")
        with patch.object(r, "convert", migrate):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()
        self.assertIn(("copy", "restore"), self.runner.calls)

    def test_migration_failure_restores_before_old_start(self):
        self.migration_failure(False)

    def test_migration_interruption_restores_before_old_start(self):
        self.migration_failure(True)

    def test_migrated_data_restored_when_candidate_never_starts(self):
        def migrate(deployment, *_):
            deployment.save(data_may_changed=True, phase="migration-intent")
            self.runner.data["database"] = "migration committed"
        self.runner.fail = "create"
        with patch.object(r, "convert", migrate):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()
        self.assertIn(("copy", "restore"), self.runner.calls)

    def test_migration_success_then_startup_failure_restores_snapshot(self):
        def migrate(deployment, *_):
            deployment.save(data_may_changed=True, phase="migration-intent")
            self.runner.data["database"] = "migration committed"
        self.runner.fail = "start"
        with patch.object(r, "convert", migrate):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()
        self.assertIn(("copy", "restore"), self.runner.calls)

    def test_ingress_opens_only_after_durable_commit(self):
        original = self.runner.run
        def run(*args, **kwargs):
            if args[:3] == ("docker", "network", "connect"):
                self.assertEqual(json.loads(r.PENDING.read_bytes())["phase"], "committed")
            if args[:2] == ("docker", "create"):
                self.assertEqual(args[args.index("--network") + 1], "none")
            return original(*args, **kwargs)
        self.runner.run = run
        self.assertEqual(r.run_transaction(self.deployment), 0)

    def test_ingress_connection_failure_never_restores_snapshot(self):
        self.runner.fail = "network"
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertEqual(json.loads(r.PENDING.read_bytes())["phase"], "committed")
        self.assertNotIn(("copy", "restore"), self.runner.calls)
        self.deployment.finish_committed()

    def test_readiness_failure_restores_data_not_just_image(self):
        def ready(container, _seconds):
            if container == "new-id":
                raise r.Failure("Deep health failed")
        self.deployment.wait_ready = ready
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()
        self.assertIn(("copy", "restore"), self.runner.calls)

    def test_compose_write_failure_recovers(self):
        real_write = r.atomic_write
        def write(path, data, mode=0o600):
            if path == self.compose and b"local-abc123" in data:
                raise OSError("Injected Compose write failure")
            return real_write(path, data, mode)
        with patch.object(r, "atomic_write", write):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()

    def test_failed_restore_never_starts_old_binary(self):
        def ready(container, _seconds):
            if container == "new-id":
                raise r.Failure("New app failed")
        self.deployment.wait_ready = ready
        def fail_restore(source, destination, restore=False):
            if restore:
                raise r.Failure("Restore failed")
            self.copy_volume(source, destination)
        self.deployment.copy_volume = fail_restore
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertFalse(self.runner.inspect("old-id")["State"]["Running"])
        self.assertTrue(r.PENDING.exists())
        self.deployment.copy_volume = self.copy_volume
        self.deployment.rollback()
        self.assert_recovered()

    def test_postcommit_cleanup_failure_never_reverts_data(self):
        self.runner.fail = "rm"
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertEqual(json.loads(r.PENDING.read_bytes())["phase"], "committed")
        self.assertEqual(self.runner.data["database"], "after migration")
        self.assertNotIn(("copy", "restore"), self.runner.calls)
        self.deployment.finish_committed()
        self.assertTrue(self.runner.inspect("new-id")["State"]["Running"])
        self.assertFalse(r.PENDING.exists())

    def test_commit_write_failure_before_replace_rolls_back_immediately(self):
        real_write = r.atomic_write
        def write(path, data, mode=0o600):
            if path == r.PENDING and json.loads(data)["phase"] == "committed":
                raise OSError("Commit write failed before replacement")
            return real_write(path, data, mode)
        with patch.object(r, "atomic_write", write):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()

    def test_commit_interruption_before_replace_rolls_back_immediately(self):
        real_write = r.atomic_write
        def write(path, data, mode=0o600):
            if path == r.PENDING and json.loads(data)["phase"] == "committed":
                r.interrupted(r.signal.SIGTERM, None)
            return real_write(path, data, mode)
        with patch.object(r, "atomic_write", write):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assert_recovered()

    def test_commit_failure_after_replace_reconciles_durably_without_rollback(self):
        real_sync = r.sync_directory
        failed = False
        def sync(path):
            nonlocal failed
            if not failed and path == r.STATE and json.loads(r.PENDING.read_bytes())["phase"] == "committed":
                failed = True
                raise OSError("Commit directory fsync failed after replacement")
            return real_sync(path)
        with patch.object(r, "sync_directory", sync):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertTrue(failed)
        self.assertEqual(json.loads(r.PENDING.read_bytes())["phase"], "committed")
        self.assertTrue(self.runner.inspect("new-id")["State"]["Running"])
        self.assertNotIn(("copy", "restore"), self.runner.calls)
        self.deployment.reconcile_journal()
        self.deployment.finish_committed()

    def test_unresolvable_commit_fsync_stops_candidate_until_recovery(self):
        real_sync = r.sync_directory
        def sync(path):
            if path == r.STATE and json.loads(r.PENDING.read_bytes())["phase"] == "committed":
                raise OSError("Persistent storage failure")
            return real_sync(path)
        with patch.object(r, "sync_directory", sync):
            self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertFalse(self.runner.inspect("new-id")["State"]["Running"])
        self.assertEqual(self.runner.inspect("new-id")["HostConfig"]["RestartPolicy"]["Name"], "no")
        self.assertNotIn(("copy", "restore"), self.runner.calls)
        self.deployment.reconcile_journal()
        self.deployment.finish_committed()
        self.assertTrue(self.runner.inspect("new-id")["State"]["Running"])
        self.assertNotIn(("copy", "restore"), self.runner.calls)

    def test_committed_resume_retries_after_restart_policy_changed_but_start_failed(self):
        self.runner.fail = "rm"
        self.assertEqual(r.run_transaction(self.deployment), 1)
        candidate = self.runner.containers["new-id"]
        candidate["State"]["Running"] = False
        candidate["HostConfig"]["RestartPolicy"]["Name"] = "no"
        self.runner.fail = "start"
        with self.assertRaises(r.Failure):
            self.deployment.finish_committed()
        self.assertEqual(candidate["HostConfig"]["RestartPolicy"]["Name"], "unless-stopped")
        self.assertFalse(candidate["State"]["Running"])
        persisted = json.loads(r.PENDING.read_bytes())
        self.assertTrue(persisted["resume_candidate"])
        recovered = r.Deployment(self.runner, persisted)
        recovered.wait_ready = lambda *_: None
        recovered.reconcile_journal()
        recovered.finish_committed()
        self.assertTrue(candidate["State"]["Running"])
        self.assertFalse(r.PENDING.exists())
        self.assertNotIn(("copy", "restore"), self.runner.calls)

    def test_recovery_after_old_restart_does_not_restore_twice(self):
        def fail_archive():
            raise OSError("Archive interrupted")
        real_archive = self.deployment.archive
        def ready(container, _seconds):
            if container == "new-id":
                raise r.Failure("New app failed")
        self.deployment.wait_ready = ready
        self.deployment.archive = fail_archive
        self.assertEqual(r.run_transaction(self.deployment), 1)
        self.assertTrue(self.runner.inspect("old-id")["State"]["Running"])
        self.runner.data["new_old_request"] = "keep"
        self.deployment.archive = real_archive
        self.deployment.rollback()
        self.assertEqual(self.runner.data["new_old_request"], "keep")
        self.assertEqual(self.runner.calls.count(("copy", "restore")), 1)

    def test_unrelated_writer_blocks_restore(self):
        self.runner.containers["unrelated"] = {"Id": "unrelated", "Name": "/other", "State": {"Running": True}}
        with self.assertRaises(r.Failure):
            self.deployment.no_writers()

    def test_image_defaults_are_not_pinned_to_old_binary(self):
        old = {"Config": {"Env": ["CLIPROXY_BUNDLED_VERSION=old", "SESSION_SECRET=private", "GOMAXPROCS=2"]}}
        image = {"Config": {"Env": ["CLIPROXY_BUNDLED_VERSION=old", "GOMAXPROCS=1"]}}
        env = r.deployment_environment(old, image, "revision")
        self.assertNotIn("CLIPROXY_BUNDLED_VERSION", env)
        self.assertEqual(env["SESSION_SECRET"], "private")
        self.assertEqual(env["GOMAXPROCS"], "2")


@unittest.skipUnless(os.getenv("RAWROUTE_TEST_DOCKER") == "1", "opt-in disposable Docker volume test")
class DockerCopyTests(unittest.TestCase):
    def test_offline_snapshot_restore_preserves_metadata_and_removes_new_files(self):
        runner = r.Runner()
        image = runner.inspect(r.NAME)["Image"]
        transaction = "test-" + uuid.uuid4().hex[:12]
        source, backup = "rawroute-test-source-" + transaction, "rawroute-test-backup-" + transaction
        manifest = {"transaction": transaction, "old": {"Image": image}, "helper": "rawroute-test-helper-" + transaction}
        deployment = r.Deployment(runner, manifest)
        try:
            for name in (source, backup):
                runner.run("docker", "volume", "create", "--label", f"{r.LABEL}={transaction}", name)
            def command(volume, script):
                runner.run("docker", "run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "/bin/sh",
                           "--mount", f"type=volume,src={volume},dst=/test,volume-nocopy", image, "-c", script)
            command(source, "mkdir /test/.hidden && printf original > /test/.hidden/data && chmod 640 /test/.hidden/data && chown 1000:1000 /test/.hidden/data && ln -s .hidden/data /test/link")
            deployment.copy_volume(source, backup)
            command(source, "printf changed > /test/.hidden/data && touch /test/new-file")
            deployment.copy_volume(backup, source, restore=True)
            command(source, "test \"$(cat /test/.hidden/data)\" = original && test \"$(stat -c '%a:%u:%g' /test/.hidden/data)\" = 640:1000:1000 && test \"$(readlink /test/link)\" = .hidden/data && test ! -e /test/new-file")
        finally:
            deployment.remove_owned_container(manifest["helper"])
            for name in (source, backup):
                if deployment.owned(name, "volume"):
                    runner.run("docker", "volume", "rm", name)


if __name__ == "__main__":
    unittest.main()
