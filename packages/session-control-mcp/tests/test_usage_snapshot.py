import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "scripts" / "claude_code_usage_snapshot.py"
spec = importlib.util.spec_from_file_location("claude_code_usage_snapshot", MODULE)
assert spec is not None and spec.loader is not None
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class UsageSnapshotTests(unittest.TestCase):
    def test_builds_only_documented_rate_limit_windows(self):
        result = snapshot.build_snapshot({"rate_limits": {
            "five_hour": {"used_percentage": 12.5, "resets_at": 2000},
            "seven_day": {"used_percentage": 34, "resets_at": 3000},
            "seven_day_opus": None,
        }}, captured_at=1000)
        self.assertEqual(result, {
            "version": 1,
            "captured_at": 1000,
            "windows": {
                "five_hour": {"used_percentage": 12.5, "resets_at": 2000},
                "seven_day": {"used_percentage": 34.0, "resets_at": 3000},
            },
        })

    def test_missing_limits_preserves_last_good_by_returning_none(self):
        self.assertIsNone(snapshot.build_snapshot({"model": {}}))
        self.assertIsNone(snapshot.build_snapshot({"rate_limits": {"seven_day_opus": None}}))

    def test_rejects_bad_percentages_resets_and_unknown_window_fields(self):
        for window in (
            {"used_percentage": -1, "resets_at": 1},
            {"used_percentage": 101, "resets_at": 1},
            {"used_percentage": True, "resets_at": 1},
            {"used_percentage": 1, "resets_at": {"bad": True}},
            {"used_percentage": 1, "resets_at": 1, "secret": "x"},
        ):
            with self.subTest(window=window), self.assertRaises(ValueError):
                snapshot.build_snapshot({"rate_limits": {"five_hour": window}})

    def test_atomically_writes_a_private_single_link_snapshot(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            os.chmod(root, 0o700)
            path = root / "usage.json"
            data = snapshot.build_snapshot({"rate_limits": {
                "five_hour": {"used_percentage": 1, "resets_at": 2},
            }}, captured_at=3)
            snapshot.write_snapshot(path, data, uid=os.getuid())
            info = path.stat()
            self.assertEqual(info.st_mode & 0o777, 0o600)
            self.assertEqual(info.st_nlink, 1)
            self.assertEqual(json.loads(path.read_text()), data)

    def test_refuses_loose_or_symlinked_directories(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / "usage.json"
            os.chmod(root, 0o755)
            with self.assertRaisesRegex(ValueError, "0700"):
                snapshot.write_snapshot(path, {"version": 1}, uid=os.getuid())
            real = root / "real"
            real.mkdir(mode=0o700)
            link = root / "link"
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                snapshot.write_snapshot(link / "usage.json", {"version": 1}, uid=os.getuid())


if __name__ == "__main__":
    unittest.main()
