import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "check_claude_compatibility.py"
spec = importlib.util.spec_from_file_location("check_claude_compatibility", MODULE)
assert spec is not None and spec.loader is not None
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)

SESSION = "11111111-1111-4111-8111-111111111111"


class ClaudeCompatibilityTests(unittest.TestCase):
    def test_version_floor_and_parser(self):
        self.assertEqual(compat.parse_version("2.1.243 (Claude Code)"), (2, 1, 243))
        with self.assertRaisesRegex(ValueError, "not parseable"):
            compat.parse_version("unknown")

    def test_settings_require_explicit_canonical_safe_memory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            memory = root / "memory"
            memory.mkdir(mode=0o755)
            settings = root / "settings.json"
            settings.write_text(json.dumps({"autoMemoryDirectory": str(memory)}))
            settings.chmod(0o600)
            self.assertEqual(compat.validate_settings(settings), memory)
            settings.write_text('{}')
            with self.assertRaisesRegex(ValueError, "required"):
                compat.validate_settings(settings)
            settings.write_text('{"autoMemoryDirectory":"a","autoMemoryDirectory":"b"}')
            with self.assertRaisesRegex(ValueError, "duplicate"):
                compat.validate_settings(settings)

    def test_stop_payload_contract_is_fail_closed(self):
        payload = {
            "session_id": SESSION,
            "prompt_id": "prompt-1",
            "hook_event_name": "Stop",
            "stop_hook_active": False,
            "last_assistant_message": "done",
            "background_tasks": [],
            "session_crons": [],
        }
        compat.validate_stop_payload(payload)
        for field in ("prompt_id", "background_tasks", "session_crons", "stop_hook_active"):
            broken = dict(payload)
            broken.pop(field)
            with self.assertRaisesRegex(ValueError, "missing"):
                compat.validate_stop_payload(broken)

    def test_capture_mode_writes_private_validated_payload_atomically(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            target = root / "compat" / "stop.json"
            payload = {
                "session_id": SESSION,
                "prompt_id": "prompt-1",
                "hook_event_name": "Stop",
                "stop_hook_active": False,
                "last_assistant_message": "done",
                "background_tasks": [],
                "session_crons": [],
            }
            compat.capture_stop_payload(target, json.dumps(payload).encode())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            compat.validate_stop_payload(json.loads(target.read_text()))
            with self.assertRaisesRegex(ValueError, "missing"):
                bad = dict(payload)
                bad.pop("background_tasks")
                compat.capture_stop_payload(target, json.dumps(bad).encode())
            real = root / "real"
            real.mkdir(mode=0o700)
            (root / "linked").symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "non-directory"):
                compat.capture_stop_payload(root / "linked" / "stop.json", json.dumps(payload).encode())

    def test_cli_reads_real_version_settings_and_captured_stop_payload(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            memory = root / "memory"
            memory.mkdir(mode=0o755)
            settings = root / "settings.json"
            settings.write_text(json.dumps({"autoMemoryDirectory": str(memory)}))
            settings.chmod(0o600)
            payload = root / "stop.json"
            payload.write_text(json.dumps({
                "session_id": SESSION,
                "prompt_id": "prompt-1",
                "hook_event_name": "Stop",
                "stop_hook_active": False,
                "last_assistant_message": "done",
                "background_tasks": [],
                "session_crons": [],
            }))
            payload.chmod(0o600)
            claude = root / "claude"
            claude.write_text("#!/bin/sh\nprintf '2.1.243 (Claude Code)\\n'\n")
            claude.chmod(0o755)
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(compat.main([
                    "--claude", str(claude),
                    "--settings", str(settings),
                    "--stop-payload", str(payload),
                ]), 0)
            result = json.loads(output.getvalue())
            self.assertEqual(result["status"], "compatible")
            self.assertTrue(result["compatible"])
            self.assertTrue(result["stop_payload_checked"])


if __name__ == "__main__":
    unittest.main()
