"""Tests for the SessionStart receipt writer (Claude Code command hook)."""

import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
MODULE_PATH = SCRIPTS_DIR / "claude_code_session_receipt.py"
spec = importlib.util.spec_from_file_location("claude_code_session_receipt", MODULE_PATH)
assert spec is not None and spec.loader is not None
receipt = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = receipt
spec.loader.exec_module(receipt)

real_load_config = receipt.load_config

NEW_SESSION = "11111111-1111-4111-8111-111111111111"
OLD_SESSION = "22222222-2222-4222-8222-222222222222"


def _hook_input(session_id=NEW_SESSION, **overrides):
    payload = {
        "hook_event_name": "SessionStart",
        "source": "startup",
        "session_id": session_id,
        "cwd": "/srv/claude-bot",
        "transcript_path": f"/home/USER/.claude/projects/srv-claude-bot/{session_id}.jsonl",
    }
    payload.update(overrides)
    return payload


def _config_data(root: Path) -> dict:
    return {
        "service_name": "claude-telegram.service",
        "service_user": "tester",
        "workspace": str(root / "workspace"),
        "project_sessions": str(root / "sessions"),
        "session_start_receipt_dir": str(root / "receipts"),
        "channel_state": str(root / "state"),
        "lock_path": "/run/lock/claude-telegram-reset.lock",
        "poller_process_marker": "bun server.ts",
        "required_process_markers": ["renderer", "control"],
    }


class SessionReceiptWriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.receipts = self.root / "receipts"
        self.receipts.mkdir(mode=0o700)

    def test_writes_a_0600_single_link_receipt_named_by_the_exact_uuid(self):
        path = receipt.write_session_receipt(self.receipts, _hook_input(), expected_uid=os.getuid())
        self.assertEqual(path, self.receipts / f"{NEW_SESSION}.json")
        info = path.stat()
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_nlink, 1)
        self.assertEqual(info.st_uid, os.getuid())

    def test_receipt_records_protocol_event_source_session_cwd_and_transcript(self):
        path = receipt.write_session_receipt(self.receipts, _hook_input(), expected_uid=os.getuid())
        payload = json.loads(path.read_text())
        self.assertEqual(payload["protocol"], receipt.PROTOCOL_VERSION)
        self.assertEqual(payload["version"], receipt.RECEIPT_VERSION)
        self.assertEqual(payload["event"], "SessionStart")
        self.assertEqual(payload["source"], "startup")
        self.assertEqual(payload["session_id"], NEW_SESSION)
        self.assertEqual(payload["cwd"], "/srv/claude-bot")
        self.assertEqual(payload["transcript_path"], f"/home/USER/.claude/projects/srv-claude-bot/{NEW_SESSION}.jsonl")

    def test_rejects_non_object_or_malformed_hook_input(self):
        with self.assertRaisesRegex(ValueError, "JSON object"):
            receipt.write_session_receipt(self.receipts, ["not", "an", "object"], expected_uid=os.getuid())
        with self.assertRaisesRegex(ValueError, "JSON object"):
            receipt.write_session_receipt(self.receipts, "plain text", expected_uid=os.getuid())
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_rejects_wrong_hook_event_or_source(self):
        for overrides in (
            {"hook_event_name": "SessionEnd"},
            {"hook_event_name": "sessionstart"},
            {"source": "resume"},
            {"source": "unknown"},
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    receipt.write_session_receipt(self.receipts, _hook_input(**overrides), expected_uid=os.getuid())
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_rejects_invalid_uuid_or_path_traversal_session_id(self):
        for bad in (
            "not-a-uuid",
            "../../etc/passwd",
            "/etc/passwd",
            "",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        ):
            with self.subTest(session_id=bad):
                with self.assertRaises(ValueError):
                    receipt.write_session_receipt(self.receipts, _hook_input(session_id=bad), expected_uid=os.getuid())
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_rejects_traversal_relative_or_mismatched_paths(self):
        cases = (
            {"cwd": "../etc/passwd"},
            {"cwd": "relative/path"},
            {"cwd": ""},
            {"transcript_path": "../etc/passwd"},
            {"transcript_path": "relative/x.jsonl"},
            {"transcript_path": f"/tmp/{OLD_SESSION}.jsonl"},
            {"transcript_path": f"/tmp/{NEW_SESSION}.txt"},
        )
        for overrides in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    receipt.write_session_receipt(self.receipts, _hook_input(**overrides), expected_uid=os.getuid())
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_rejects_unknown_input_fields(self):
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            receipt.write_session_receipt(self.receipts, _hook_input(extra="spoof"), expected_uid=os.getuid())
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_refuses_to_overwrite_an_existing_receipt_and_preserves_it(self):
        first = receipt.write_session_receipt(self.receipts, _hook_input(), expected_uid=os.getuid())
        original = first.read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            receipt.write_session_receipt(self.receipts, _hook_input(), expected_uid=os.getuid())
        self.assertEqual(first.read_bytes(), original)

    def test_rejection_leaves_no_temp_or_partial_artifacts(self):
        receipt.write_session_receipt(self.receipts, _hook_input(OLD_SESSION), expected_uid=os.getuid())
        before = sorted(p.name for p in self.receipts.iterdir())
        with self.assertRaises(ValueError):
            receipt.write_session_receipt(self.receipts, _hook_input(transcript_path="/tmp/x.jsonl"), expected_uid=os.getuid())
        self.assertEqual(sorted(p.name for p in self.receipts.iterdir()), before)
        self.assertFalse(any(".tmp." in name for name in before))

    def test_rejects_symlinked_foreign_or_loose_receipt_directories(self):
        real = self.root / "real"
        real.mkdir()
        os.symlink(real, self.root / "linked")
        with self.assertRaisesRegex(ValueError, "real directory"):
            receipt.write_session_receipt(self.root / "linked", _hook_input(), expected_uid=os.getuid())

        loose = self.root / "loose"
        loose.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, "0700"):
            receipt.write_session_receipt(loose, _hook_input(), expected_uid=os.getuid())

        with self.assertRaisesRegex(ValueError, "user-owned"):
            receipt.write_session_receipt(self.receipts, _hook_input(), expected_uid=os.getuid() + 4242)

    def test_writer_does_not_require_root(self):
        with mock.patch.object(receipt.os, "geteuid", return_value=os.getuid()):
            path = receipt.write_session_receipt(self.receipts, _hook_input(), expected_uid=os.getuid())
        self.assertTrue(path.exists())

    def test_main_reads_bounded_stdin_and_prints_written_receipt(self):
        cfg_path = self.root / "reset.json"
        cfg_path.write_text(json.dumps(_config_data(self.root)))
        os.chmod(cfg_path, 0o644)
        data = json.dumps(_hook_input()).encode()
        fake_sys = SimpleNamespace(stdin=SimpleNamespace(buffer=io.BytesIO(data)), stderr=io.StringIO())
        with mock.patch.object(receipt, "sys", fake_sys), \
                mock.patch.object(
                    receipt,
                    "load_config",
                    side_effect=lambda path: real_load_config(path, expected_uid=os.getuid(), user_lookup=lambda n: os.getuid()),
                ), \
                redirect_stdout(io.StringIO()) as out:
            code = receipt.main(["--config", str(cfg_path)])
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result["status"], "written")
        self.assertTrue(Path(result["receipt"]).exists())

    def test_main_rejects_oversized_stdin(self):
        cfg_path = self.root / "reset.json"
        cfg_path.write_text(json.dumps(_config_data(self.root)))
        os.chmod(cfg_path, 0o644)
        data = json.dumps(_hook_input(cwd="/" + ("x" * (receipt.MAX_STDIN_BYTES + 1)))).encode()
        fake_sys = SimpleNamespace(stdin=SimpleNamespace(buffer=io.BytesIO(data)), stderr=io.StringIO())
        with mock.patch.object(receipt, "sys", fake_sys), \
                mock.patch.object(receipt, "load_config", side_effect=lambda path: real_load_config(
                    path, expected_uid=os.getuid(), user_lookup=lambda n: os.getuid(),
                )):
            code = receipt.main(["--config", str(cfg_path)])
        self.assertEqual(code, 1)
        self.assertIn("too large", fake_sys.stderr.getvalue())
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_main_refuses_to_run_as_root(self):
        fake_sys = SimpleNamespace(stdin=SimpleNamespace(buffer=io.BytesIO(b"{}")), stderr=io.StringIO())
        with mock.patch.object(receipt.os, "geteuid", return_value=0), mock.patch.object(receipt, "sys", fake_sys):
            code = receipt.main(["--config", "/nonexistent/reset.json"])
        self.assertEqual(code, 1)
        self.assertIn("must not run as root", fake_sys.stderr.getvalue())
        self.assertEqual(list(self.receipts.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
