import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy_local.py"
spec = importlib.util.spec_from_file_location("deploy_local", MODULE_PATH)
assert spec is not None and spec.loader is not None
deploy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = deploy
spec.loader.exec_module(deploy)

SHA_A = "a" * 40
SHA_B = "b" * 40


class RefTests(unittest.TestCase):
    def test_requires_exact_commit_sha(self):
        self.assertEqual(deploy.validate_sha(SHA_A), SHA_A)
        for bad in ("main", "HEAD", "a" * 39, "g" * 40):
            with self.assertRaisesRegex(ValueError, "exact 40-character"):
                deploy.validate_sha(bad)


class ActivationTests(unittest.TestCase):
    def test_activate_and_rollback_swap_current_and_previous(self):
        with tempfile.TemporaryDirectory() as td:
            prefix = Path(td)
            releases = prefix / "releases"
            first = releases / SHA_A
            second = releases / SHA_B
            first.mkdir(parents=True)
            second.mkdir()

            receipt1 = deploy.activate_release(prefix, first)
            self.assertEqual(receipt1["current"], SHA_A)
            self.assertIsNone(receipt1["previous"])
            self.assertEqual((prefix / "current").resolve(), first)

            receipt2 = deploy.activate_release(prefix, second)
            self.assertEqual(receipt2["current"], SHA_B)
            self.assertEqual(receipt2["previous"], SHA_A)
            self.assertEqual((prefix / "current").resolve(), second)
            self.assertEqual((prefix / "previous").resolve(), first)

            receipt3 = deploy.rollback(prefix)
            self.assertEqual(receipt3["current"], SHA_A)
            self.assertEqual(receipt3["previous"], SHA_B)
            self.assertEqual((prefix / "current").resolve(), first)
            self.assertEqual((prefix / "previous").resolve(), second)

    def test_rejects_release_outside_prefix(self):
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as other:
            prefix = Path(td)
            target = Path(other) / SHA_A
            target.mkdir()
            with self.assertRaisesRegex(ValueError, "inside the release directory"):
                deploy.activate_release(prefix, target)


if __name__ == "__main__":
    unittest.main()
