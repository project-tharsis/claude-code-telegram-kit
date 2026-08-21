from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "check_versions.py"


class VersionCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.root / "scripts" / "check_versions.py")
        self.version = "0.3.0"
        (self.root / "package.json").write_text('{"version":"0.3.0"}')
        for name in ("shared", "renderer", "control"):
            package = self.root / "packages" / name
            (package / "src").mkdir(parents=True)
            (package / "package.json").write_text('{"version":"0.3.0"}')
        for name in ("renderer", "control"):
            (self.root / "packages" / name / "src" / "server.ts").write_text(
                f'new Server({{ name: "{name}", version: "0.3.0" }}, {{}});'
            )
        self.lock = self.root / "bun.lock"
        self.lock.write_text(
            '{\n  "workspaces": {\n'
            '    "packages/shared": {\n      "version": "0.3.0",\n    },\n'
            '    "packages/renderer": {\n      "version": "0.3.0",\n    },\n'
            '    "packages/control": {\n      "version": "0.3.0",\n    },\n'
            '  },\n}\n'
        )

    def run_check(self):
        return subprocess.run(
            [sys.executable, str(self.root / "scripts" / "check_versions.py")],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_accepts_one_version_across_all_authorities(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("version-check: 0.3.0", result.stdout)

    def test_rejects_an_mcp_server_identity_drift(self):
        server = self.root / "packages" / "renderer" / "src" / "server.ts"
        server.write_text(server.read_text().replace('version: "0.3.0"', 'version: "9.9.9"'))
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("server.ts", result.stderr)

    def test_rejects_a_bun_lock_workspace_drift(self):
        self.lock.write_text(self.lock.read_text().replace('"version": "0.3.0"', '"version": "9.9.9"', 1))
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bun.lock", result.stderr)


if __name__ == "__main__":
    unittest.main()
