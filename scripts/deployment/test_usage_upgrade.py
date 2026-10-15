"""Report validation and durable apply ordering; no Docker commands are executed."""
import copy
import json
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from usage_upgrade import convert


class ConversionTests(unittest.TestCase):
    def run_conversion(self, mutate=None, uncertain=False):
        before = {"classifications": [{"financialState": "unknown" if uncertain else "known"}],
                  "plannedDigest": "projection", "sourceDigest": "original", "sourceDocuments": 1,
                  "rawDocuments": 1, "copiedRawDocuments": 1, "buckets": 2,
                  "workspaceTotals": {"default": 1}, "workspaceDailySums": {"default": 1}, "unchanged": False}
        after = {**copy.deepcopy(before), "sourceDocuments": 2, "copiedRawDocuments": 0, "unchanged": True}
        if mutate:
            mutate(after)
        reports = iter([before, before, after])
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            d = SimpleNamespace(directory=Path(directory), m={"helper": "test-helper", "transaction": "test", "new_image": "test-image"})
            def save(**changes):
                d.m.update(changes)
            d.save = save
            def run(*args, **_):
                calls.append(args)
                self.assertEqual(args[args.index("--network") + 1], "none")
                if "--apply" in args:
                    self.assertTrue(d.m["data_may_changed"])
                    self.assertIn("--writers-stopped", args)
                return subprocess.CompletedProcess(args, 0, json.dumps(next(reports)).encode(), b"")
            d.runner = SimpleNamespace(run=run)
            try:
                return convert(d, "test-volume", "test-prefix", "UTC")
            finally:
                for path in Path(directory).glob("*.json"):
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                if uncertain:
                    self.assertEqual(len(calls), 1)
                    self.assertNotIn("data_may_changed", d.m)

    def test_success_and_durable_intent(self):
        self.assertTrue(self.run_conversion()["unchanged"])

    def test_uncertainty_aborts_before_apply(self):
        with self.assertRaisesRegex(ValueError, "uncertain"):
            self.run_conversion(uncertain=True)

    def test_non_idempotent_preview_rejected(self):
        with self.assertRaisesRegex(ValueError, "idempotent"):
            self.run_conversion(lambda report: report.update(unchanged=False))

    def test_source_loss_rejected(self):
        with self.assertRaisesRegex(ValueError, "source count"):
            self.run_conversion(lambda report: report.update(sourceDocuments=1))

    def test_projection_change_rejected(self):
        with self.assertRaisesRegex(ValueError, "mismatch"):
            self.run_conversion(lambda report: report.update(plannedDigest="different"))


if __name__ == "__main__":
    unittest.main()
