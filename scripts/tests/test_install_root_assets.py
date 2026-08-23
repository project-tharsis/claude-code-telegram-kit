from __future__ import annotations

import grp
import importlib.util
import json
import os
import pwd
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "install_root_assets.py"
SPEC = importlib.util.spec_from_file_location("root_assets", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
root_assets = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = root_assets
SPEC.loader.exec_module(root_assets)


class RootAssetInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo = base / "repo"
        self.root = base / "root"
        self.state = base / "state"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "Test"], check=True)
        for asset in root_assets.ASSETS:
            path = self.repo / asset.source
            path.parent.mkdir(parents=True, exist_ok=True)
            if asset.source.endswith("claude-code-telegram-kit-tmpfiles.conf"):
                content = "d /run/example 0750 root SERVICE_GROUP -\n# USER\n"
            else:
                content = "SocketUser=USER\n" if asset.render_user else f"asset:{asset.source}\n"
            path.write_text(content)
        installer = self.repo / root_assets.SELF_PATH
        installer.parent.mkdir(parents=True, exist_ok=True)
        installer.write_bytes(SCRIPT.read_bytes())
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "fixture"], check=True)
        self.commit = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        self.uid = os.getuid()
        self.gid = os.getgid()
        self.user = pwd.getpwuid(self.uid).pw_name

    def install(self):
        return root_assets.install_release(
            self.repo,
            self.commit,
            self.user,
            state_root=self.state,
            root_prefix=self.root,
            owner_uid=self.uid,
            owner_gid=self.gid,
            verify_self=True,
        )

    def test_exact_commit_install_hash_readback_and_rollback(self):
        first = root_assets.ASSETS[0]
        old_path = self.root / first.destination.lstrip("/")
        old_path.parent.mkdir(parents=True)
        old_path.write_text("old\n")
        old_path.chmod(0o755)

        result = self.install()
        self.assertEqual(result["commit"], self.commit)
        self.assertEqual(result["bun"]["path"], str(Path(pwd.getpwuid(self.uid).pw_dir) / ".bun/bin/bun"))
        self.assertEqual(len(result["bun"]["sha256"]), 64)
        installed_manifest = json.loads((self.state / "installed.json").read_text())
        self.assertEqual(installed_manifest["bun"], result["bun"])
        for asset in root_assets.ASSETS:
            installed = self.root / asset.destination.lstrip("/")
            self.assertTrue(installed.is_file())
            self.assertEqual(installed.stat().st_mode & 0o777, asset.mode)
        socket_text = (self.root / "etc/systemd/system/claude-code-control.socket").read_text()
        self.assertIn(f"SocketUser={self.user}", socket_text)
        self.assertNotIn("SocketUser=USER", socket_text)
        group = grp.getgrgid(self.gid).gr_name
        tmpfiles_text = (self.root / "usr/lib/tmpfiles.d/claude-code-telegram-kit.conf").read_text()
        self.assertIn(f"root {group}", tmpfiles_text)
        self.assertNotIn("SERVICE_GROUP", tmpfiles_text)

        rolled = root_assets.rollback_release(state_root=self.state, owner_uid=self.uid, owner_gid=self.gid)
        self.assertEqual(rolled["rolled_back"], self.commit)
        self.assertEqual(old_path.read_text(), "old\n")
        self.assertFalse((self.state / "installed.json").exists())
        for asset in root_assets.ASSETS[1:]:
            self.assertFalse((self.root / asset.destination.lstrip("/")).exists())

    def test_rollback_restores_the_previous_installed_manifest(self):
        with mock.patch.object(root_assets.time, "time", side_effect=[100, 101]):
            self.install()
            previous = (self.state / "installed.json").read_bytes()
            second = self.install()
        self.assertNotEqual((self.state / "installed.json").read_bytes(), b"")
        rolled = root_assets.rollback_release(state_root=self.state, owner_uid=self.uid, owner_gid=self.gid)
        self.assertEqual(rolled["backup"], second["backup"])
        self.assertEqual((self.state / "installed.json").read_bytes(), previous)

    def test_activation_tmpfiles_repairs_control_socket_parent_and_isolates_env(self):
        policy = (SCRIPT.parents[1] / "examples/claude-code-telegram-kit-tmpfiles.conf").read_text()
        self.assertIn("d /run/claude-code-telegram-kit 0755 root root", policy)
        self.assertNotIn("d /run/claude-code-telegram-kit 0700", policy)
        self.assertIn("d /run/claude-code-telegram-activation 0700 root root", policy)
        drop_in = (SCRIPT.parents[1] / "examples/claude-telegram-activation.conf").read_text()
        self.assertIn("/run/claude-code-telegram-activation/activation.env", drop_in)

    def test_rejects_non_exact_commit_and_restores_on_failed_readback(self):
        with self.assertRaises(ValueError):
            root_assets.install_release(
                self.repo, "HEAD", "service-user", state_root=self.state,
                root_prefix=self.root, owner_uid=self.uid, owner_gid=self.gid, verify_self=False,
            )
        with mock.patch.object(root_assets, "_verify_destination", side_effect=RuntimeError("mismatch")):
            with self.assertRaisesRegex(RuntimeError, "mismatch"):
                self.install()
        self.assertFalse((self.state / "installed.json").exists())

    def test_rejects_root_service_user(self):
        with mock.patch.object(root_assets.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=0)):
            with self.assertRaisesRegex(ValueError, "unprivileged"):
                root_assets.install_release(
                    self.repo, self.commit, "root", state_root=self.state,
                    root_prefix=self.root, owner_uid=self.uid, owner_gid=self.gid, verify_self=True,
                )


if __name__ == "__main__":
    unittest.main()
