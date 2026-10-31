"""External Compose volume migration tests; no real Docker volumes are touched."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("external_volume", Path(__file__).with_name("migrate_external_volume.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.fail_copy = False
        self.fail_migration = False
        self.running_volumes = set()
        self.image_tags = {}
        self.migration_calls = []
        self.migration_results = [
            {"applied": False, "required": True, "accounts": 1, "resetRecords": 1},
            {"applied": False, "required": True, "accounts": 1, "resetRecords": 1},
            {"applied": True, "required": False, "accounts": 1, "resetRecords": 1},
            {"applied": False, "required": False, "accounts": 0, "resetRecords": 0},
        ]
        self.source_data = {"rawroute.sqlite": b"database", "rawroute.sqlite-wal": b"wal", "private": b"credential"}
        self.volumes = {
            "old-project_rawroute-data": {
                "Name": "old-project_rawroute-data",
                "Labels": {migration.PROJECT_LABEL: "old-project", migration.VOLUME_LABEL: "rawroute-data"},
                "Data": self.source_data,
            },
        }
        self.containers = {
            "old-container-id": {
                "Id": "old-container-id", "Image": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "Config": {"Labels": {migration.PROJECT_LABEL: "old-project", "com.docker.compose.service": "rawroute"}},
                "Mounts": [{"Type": "volume", "Name": "old-project_rawroute-data", "Destination": "/data", "RW": True}],
                "State": {"Running": False},
            },
            "old-engine-id": {
                "Id": "old-engine-id", "Image": "old-engine-image",
                "Config": {"Labels": {migration.PROJECT_LABEL: "old-project", "com.docker.compose.service": "cli-proxy-api"}},
                "Mounts": [
                    {"Type": "bind", "Source": "/old Compose project/cliproxy/config.yaml", "Destination": "/CLIProxyAPI/config.yaml", "RW": True},
                    {"Type": "bind", "Source": "/old Compose project/cliproxy/auths", "Destination": "/root/.cli-proxy-api", "RW": True},
                ],
                "State": {"Running": False},
            },
        }
        self.new_image_id = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

    def run(self, *args, check=True, timeout=None):
        self.calls.append(args)
        output = b""
        if args[:3] == ("docker", "container", "inspect"):
            container = self.containers.get(args[3])
            if container is None:
                return subprocess.CompletedProcess(args, 1, b"", b"missing")
            output = json.dumps([container]).encode()
        elif args[:3] == ("docker", "volume", "inspect"):
            volume = self.volumes.get(args[3])
            if volume is None:
                return subprocess.CompletedProcess(args, 1, b"", b"missing")
            output = json.dumps([{key: value for key, value in volume.items() if key != "Data"}]).encode()
        elif args[:2] == ("docker", "info"):
            output = b"test-daemon"
        elif args[:3] == ("docker", "ps", "-q"):
            volume = args[-1].split("=", 1)[1]
            output = (volume if volume in self.running_volumes else "").encode()
        elif args[:3] == ("docker", "image", "inspect"):
            if args[3] == "--format":
                output = self.containers["old-container-id"]["Image"].encode()
            elif args[3] == "new-image":
                output = json.dumps([{"Id": self.new_image_id}]).encode()
            else:
                image = self.image_tags.get(args[3])
                if image is None:
                    return subprocess.CompletedProcess(args, 1, b"", b"missing")
                output = json.dumps([{"Id": image}]).encode()
        elif args[:3] == ("docker", "image", "tag"):
            self.image_tags[args[4]] = args[3]
        elif args[:3] == ("docker", "volume", "create"):
            labels = {}
            for index, value in enumerate(args[:-1]):
                if value == "--label":
                    key, label = args[index + 1].split("=", 1)
                    labels[key] = label
            self.volumes[args[-1]] = {"Name": args[-1], "Labels": labels, "Data": {}}
            output = args[-1].encode()
        elif args[:2] == ("docker", "run"):
            if "migrations/codex-credentials.js" in args:
                self.migration_calls.append(args)
                if not self.migration_results:
                    raise AssertionError("unexpected extra Codex migration invocation")
                if self.fail_migration and "--apply" in args:
                    raise migration.Failure("synthetic importer interruption")
                result = self.migration_results.pop(0)
                if "--apply" in args:
                    target = next(value for value in args if value.startswith("type=volume,") and ",dst=/data," in value)
                    volume = target.split("src=", 1)[1].split(",", 1)[0]
                    self.volumes[volume]["Data"]["codex-schema"] = b"1"
                    result["backup"] = args[args.index("--backup-dir") + 1]
                return subprocess.CompletedProcess(args, 0, json.dumps(result).encode(), b"")
            if self.fail_copy and "-ec" in args and "cp -a /src/. /dst/" in args[-1]:
                raise migration.Failure("synthetic copy interruption")
            mounts = [value for value in args if value.startswith("type=volume,")]
            if mounts:
                source = next(value for value in mounts if ",src=old-project_rawroute-data," in value)
                target = next(value for value in mounts if ",dst=/dst," in value)
                self.assert_read_only_source(source)
                target_name = target.split("src=", 1)[1].split(",", 1)[0]
                self.volumes[target_name]["Data"] = copy.deepcopy(self.source_data)
        return subprocess.CompletedProcess(args, 0, output, b"")

    @staticmethod
    def assert_read_only_source(mount):
        if ",readonly," not in mount:
            raise AssertionError("source volume was not mounted read-only")


class ExternalVolumeMigrationTests(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()

    def test_preview_uses_inspected_original_relative_bind_mounts_read_only(self):
        plan = migration.migrate_external_volume(self.runner, "old-container-id", "old-engine-id", "new-image")
        self.assertEqual(plan["applied"], False)
        self.assertEqual(plan["project"], "old-project")
        self.assertEqual(plan["sourceVolume"], "old-project_rawroute-data")
        self.assertEqual(plan["destinationVolume"], "old-project_rawroute-managed-data")
        self.assertEqual(plan["rollbackImage"], "rawroute:external-rollback-0123456789ab")
        self.assertEqual(plan["newImageTag"], "rawroute:external-upgrade-abcdef012345")
        self.assertEqual(plan["credentialMigration"], {"required": True, "accounts": 1, "resetRecords": 1})
        self.assertNotIn("authSource", plan)
        self.assertNotIn("configSource", plan)
        self.assertFalse(any(call[:3] == ("docker", "volume", "create") for call in self.runner.calls))
        self.assertFalse(any(call[:3] == ("docker", "image", "tag") for call in self.runner.calls))
        preview = self.runner.migration_calls[0]
        self.assertIn("type=volume,src=old-project_rawroute-data,dst=/data,volume-nocopy,readonly", preview)
        self.assertIn("type=bind,src=/old Compose project/cliproxy/auths,dst=/root/.cli-proxy-api,readonly", preview)
        self.assertIn("type=bind,src=/old Compose project/cliproxy/config.yaml,dst=/legacy/cliproxy-config.yaml,readonly", preview)
        self.assertIn("--user", preview)
        self.assertEqual(preview[preview.index("--user") + 1], "0:0")
        self.assertIn("HOME=/root", preview)
        self.assertEqual(preview[preview.index("--auth-dir") + 1], "/root/.cli-proxy-api")
        self.assertEqual(preview[preview.index("--config") + 1], "/legacy/cliproxy-config.yaml")

    def test_apply_copies_data_and_runs_checked_schema_and_account_import(self):
        original = copy.deepcopy(self.runner.source_data)
        original_auth = copy.deepcopy(self.runner.containers["old-engine-id"]["Mounts"])
        result = migration.migrate_external_volume(
            self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.assertTrue(result["applied"])
        self.assertEqual(self.runner.volumes[result["sourceVolume"]]["Data"], original)
        self.assertEqual(self.runner.volumes[result["destinationVolume"]]["Data"]["rawroute.sqlite"], original["rawroute.sqlite"])
        self.assertEqual(self.runner.volumes[result["destinationVolume"]]["Data"]["codex-schema"], b"1")
        self.assertEqual(self.runner.containers["old-engine-id"]["Mounts"], original_auth)
        self.assertEqual(self.runner.image_tags[result["rollbackImage"]], result["oldImage"])
        self.assertEqual(self.runner.image_tags[result["newImageTag"]], self.runner.new_image_id)
        self.assertRegex(result["credentialBackup"], r"^/data/\.codex-before-external-migration-[0-9a-f]{16}$")
        self.assertEqual(len(self.runner.migration_calls), 4)
        for call in self.runner.migration_calls:
            self.assertIn("--network", call)
            self.assertEqual(call[call.index("--network") + 1], "none")
            self.assertIn("type=bind,src=/old Compose project/cliproxy/auths,dst=/root/.cli-proxy-api,readonly", call)
            self.assertIn("type=bind,src=/old Compose project/cliproxy/config.yaml,dst=/legacy/cliproxy-config.yaml,readonly", call)
        apply_call = next(call for call in self.runner.migration_calls if "--apply" in call)
        self.assertIn("--writers-stopped", apply_call)
        self.assertIn("--backup-dir", apply_call)
        destination_preview = next(call for call in self.runner.migration_calls if "type=volume,src=old-project_rawroute-managed-data,dst=/data,volume-nocopy,readonly" in call)
        self.assertIsNot(destination_preview, apply_call)

    def test_zero_account_external_database_still_applies_required_schema_marker(self):
        self.runner.migration_results = [
            {"applied": False, "required": True, "accounts": 0, "resetRecords": 0},
            {"applied": False, "required": True, "accounts": 0, "resetRecords": 0},
            {"applied": True, "required": False, "accounts": 0, "resetRecords": 0},
            {"applied": False, "required": False, "accounts": 0, "resetRecords": 0},
        ]
        result = migration.migrate_external_volume(
            self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.assertTrue(result["applied"])
        self.assertEqual(self.runner.volumes[result["destinationVolume"]]["Data"]["codex-schema"], b"1")
        self.assertTrue(any("--apply" in call for call in self.runner.migration_calls))

    def test_apply_requires_stopped_writers_engine_and_unclaimed_canonical_volume(self):
        self.runner.containers["old-container-id"]["State"]["Running"] = True
        with self.assertRaisesRegex(migration.Failure, "RawRoute container"):
            migration.migrate_external_volume(self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.runner.containers["old-container-id"]["State"]["Running"] = False
        self.runner.containers["old-engine-id"]["State"]["Running"] = True
        with self.assertRaisesRegex(migration.Failure, "CLIProxy container"):
            migration.migrate_external_volume(self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.runner.containers["old-engine-id"]["State"]["Running"] = False
        self.runner.running_volumes.add("old-project_rawroute-data")
        with self.assertRaisesRegex(migration.Failure, "running container"):
            migration.migrate_external_volume(self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.runner.running_volumes.clear()
        self.runner.volumes["old-project_rawroute-managed-data"] = {"Name": "old-project_rawroute-managed-data", "Labels": {}, "Data": {}}
        with self.assertRaisesRegex(migration.Failure, "already exists"):
            migration.migrate_external_volume(self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)

    def test_interrupted_copy_leaves_original_volume_and_rollback_image_intact(self):
        original = copy.deepcopy(self.runner.source_data)
        self.runner.fail_copy = True
        with self.assertRaisesRegex(migration.Failure, "remain intact"):
            migration.migrate_external_volume(self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.assertEqual(self.runner.volumes["old-project_rawroute-data"]["Data"], original)
        self.assertEqual(self.runner.image_tags["rawroute:external-rollback-0123456789ab"], self.runner.containers["old-container-id"]["Image"])

    def test_interrupted_credential_import_keeps_old_volume_image_and_auth_sources(self):
        original_data = copy.deepcopy(self.runner.source_data)
        original_mounts = copy.deepcopy(self.runner.containers["old-engine-id"]["Mounts"])
        self.runner.fail_migration = True
        with self.assertRaisesRegex(migration.Failure, "remain intact"):
            migration.migrate_external_volume(
                self.runner, "old-container-id", "old-engine-id", "new-image", apply=True, writers_stopped=True)
        self.assertEqual(self.runner.volumes["old-project_rawroute-data"]["Data"], original_data)
        self.assertEqual(self.runner.containers["old-engine-id"]["Mounts"], original_mounts)
        self.assertEqual(self.runner.image_tags["rawroute:external-rollback-0123456789ab"], self.runner.containers["old-container-id"]["Image"])

    def test_old_relative_mounts_remain_under_the_original_project_directory_for_rollback(self):
        readme = Path(__file__).parents[2] / "README.md"
        contents = readme.read_text()
        self.assertIn('OLD_COMPOSE="$OLD_PROJECT_DIR/docker-compose.external.rollback.yml"', contents)
        self.assertIn('--project-directory "$OLD_PROJECT_DIR"', contents)
        self.assertIn("docker-compose.external.rollback.yml` beside the original `cliproxy/` directory", contents)


if __name__ == "__main__":
    unittest.main()
