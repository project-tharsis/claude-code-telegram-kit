import importlib.util
import json
import subprocess
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
            (first / ".installed.json").write_text(json.dumps({"commit": SHA_A}) + "\n")
            (second / ".installed.json").write_text(json.dumps({"commit": SHA_B}) + "\n")

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

    def test_rejects_release_with_mismatched_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            prefix = Path(td)
            target = prefix / "releases" / SHA_A
            target.mkdir(parents=True)
            (target / ".installed.json").write_text(json.dumps({"commit": SHA_B}) + "\n")
            with self.assertRaisesRegex(ValueError, "receipt commit"):
                deploy.activate_release(prefix, target)


class InstallIntegrationTests(unittest.TestCase):
    def test_install_release_from_real_git_archive_on_python_311(self):
        with tempfile.TemporaryDirectory() as repo_dir, tempfile.TemporaryDirectory() as prefix_dir:
            repo = Path(repo_dir)
            prefix = Path(prefix_dir)
            subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "ci@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "CI"], check=True)
            (repo / "package.json").write_text('{"name":"fixture","private":true}\n')
            (repo / "bun.lock").write_text("fixture-lock\n")
            (repo / "payload.txt").write_text("archive payload\n")
            (repo / "AGENTS.md").write_text("guidance\n")
            (repo / "CLAUDE.md").symlink_to("AGENTS.md")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-m", "fixture"], check=True, capture_output=True)
            sha = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

            receipt = deploy.install_release(repo, sha, prefix, "/bin/true")

            self.assertEqual(receipt["commit"], sha)
            current = (prefix / "current").resolve(strict=True)
            self.assertEqual(current.name, sha)
            self.assertEqual((current / "payload.txt").read_text(), "archive payload\n")
            self.assertTrue((current / "CLAUDE.md").is_symlink())
            self.assertEqual((current / "CLAUDE.md").readlink(), Path("AGENTS.md"))
            self.assertEqual((current / "CLAUDE.md").read_text(), "guidance\n")
            installed = json.loads((current / ".installed.json").read_text())
            self.assertEqual(installed["commit"], sha)

    def test_rejects_any_other_archive_symlink(self):
        with tempfile.TemporaryDirectory() as repo_dir, tempfile.TemporaryDirectory() as prefix_dir:
            repo = Path(repo_dir)
            subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "ci@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "CI"], check=True)
            (repo / "package.json").write_text('{"name":"fixture","private":true}\n')
            (repo / "bun.lock").write_text("fixture-lock\n")
            (repo / "AGENTS.md").write_text("guidance\n")
            (repo / "CLAUDE.md").symlink_to("../outside")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-m", "fixture"], check=True, capture_output=True)
            sha = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
            ).stdout.strip()
            with self.assertRaisesRegex(ValueError, "unsupported symbolic link"):
                deploy.install_release(repo, sha, Path(prefix_dir), "/bin/true")


if __name__ == "__main__":
    unittest.main()
