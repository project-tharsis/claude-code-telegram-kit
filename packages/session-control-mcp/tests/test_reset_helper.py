import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "claude_code_session_reset.py"
spec = importlib.util.spec_from_file_location("claude_code_session_reset", MODULE_PATH)
assert spec is not None and spec.loader is not None
reset = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = reset
spec.loader.exec_module(reset)

TEST_TOKEN = "123456789:" + ("A" * 32)
TEST_CHAT_ID = "123456789"
NEW_SESSION = "11111111-1111-4111-8111-111111111111"
OLD_SESSION = "22222222-2222-4222-8222-222222222222"
BASE_UNIT = """[Service]\nWorkingDirectory=/srv/claude-bot\nExecStart=/usr/bin/script -qefc \"/opt/claude/bin/claude --continue --channels plugin:telegram@claude-plugins-official --permission-mode auto\" /dev/null\n"""


class UnitContractTests(unittest.TestCase):
    def test_fresh_unit_replaces_continue_and_adds_exact_seed(self):
        unit = reset.fresh_unit_from_continue(BASE_UNIT, NEW_SESSION)
        self.assertIn(f"--session-id {NEW_SESSION}", unit)
        self.assertNotIn("--continue", unit)
        self.assertIn(reset.DEFAULT_FRESH_SEED, unit)

    def test_resume_unit_targets_exact_old_session_without_seed(self):
        unit = reset.resume_unit_from_continue(BASE_UNIT, OLD_SESSION)
        self.assertIn(f"--resume {OLD_SESSION}", unit)
        self.assertNotIn("--continue", unit)
        self.assertNotIn(reset.DEFAULT_FRESH_SEED, unit)

    def test_rejects_noncanonical_unit(self):
        with self.assertRaisesRegex(ValueError, "exactly one --continue"):
            reset.fresh_unit_from_continue(BASE_UNIT.replace("--continue", ""), NEW_SESSION)


class ConfigTests(unittest.TestCase):
    def test_loads_root_owned_parameterized_reset_config(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / "reset.json"
            data = {
                "service_name": "my-claude.service",
                "service_user": "tester",
                "workspace": "/srv/claude-bot",
                "project_sessions": "/srv/claude-state/sessions",
                "channel_state": "/srv/claude-state/telegram",
                "lock_path": "/run/lock/my-claude-reset.lock",
                "poller_process_marker": "bun server.ts",
                "required_process_markers": ["telegram-renderer-mcp/src/server.ts", "session-control-mcp/src/server.ts"]
            }
            path.write_text(json.dumps(data))
            os.chmod(path, 0o644)
            config = reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid())
            self.assertEqual(config.service_name, "my-claude.service")
            self.assertEqual(config.workspace, Path("/srv/claude-bot"))
            self.assertEqual(config.unit_path, Path("/etc/systemd/system/my-claude.service"))
            self.assertEqual(config.required_process_markers, tuple(data["required_process_markers"]))

    def test_rejects_unknown_config_fields(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "reset.json"
            path.write_text(json.dumps({"unknown": True}))
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, "unknown config fields"):
                reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid())


class AuthorityTests(unittest.TestCase):
    def test_notification_target_requires_secure_allowlist_state(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            (state / ".env").write_text(f"TELEGRAM_BOT_TOKEN={TEST_TOKEN}\n")
            (state / "access.json").write_text(json.dumps({
                "dmPolicy": "allowlist",
                "allowFrom": [TEST_CHAT_ID],
                "groups": {},
                "pending": {}
            }))
            os.chmod(state / ".env", 0o600)
            os.chmod(state / "access.json", 0o600)
            token = reset.validate_notification_target(state, TEST_CHAT_ID, expected_uid=os.getuid())
            self.assertEqual(token, TEST_TOKEN)
            with self.assertRaisesRegex(ValueError, "not authorized"):
                reset.validate_notification_target(state, "999", expected_uid=os.getuid())
            os.chmod(state / ".env", 0o644)
            with self.assertRaisesRegex(ValueError, "mode 0600"):
                reset.validate_notification_target(state, TEST_CHAT_ID, expected_uid=os.getuid())

    def test_ready_requires_exact_new_session_assistant_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "session.jsonl"
            path.write_text(json.dumps({"sessionId": "x", "message": {"role": "assistant", "content": [{"type": "text", "text": "READY"}]}}) + "\n")
            self.assertTrue(reset.transcript_has_ready(path, "x"))
            self.assertFalse(reset.transcript_has_ready(path, "other"))
            path.write_text(json.dumps({"sessionId": "x", "message": {"role": "assistant", "content": "not ready"}}) + "\n")
            self.assertFalse(reset.transcript_has_ready(path, "x"))


class RequestIdempotencyTests(unittest.TestCase):
    def test_request_receipt_prevents_a_second_reset(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            request_id = "a" * 24
            first = reset.claim_request(state, request_id, "123456789", expected_uid=os.getuid())
            self.assertTrue(first["claimed"])
            second = reset.claim_request(state, request_id, "123456789", expected_uid=os.getuid())
            self.assertFalse(second["claimed"])
            self.assertEqual(second["receipt"]["status"], "in_progress")

            reset.finish_request(state, request_id, "complete", {"new_session": NEW_SESSION}, expected_uid=os.getuid())
            third = reset.claim_request(state, request_id, "123456789", expected_uid=os.getuid())
            self.assertFalse(third["claimed"])
            self.assertEqual(third["receipt"]["status"], "complete")
            self.assertEqual(third["receipt"]["new_session"], NEW_SESSION)


if __name__ == "__main__":
    unittest.main()
