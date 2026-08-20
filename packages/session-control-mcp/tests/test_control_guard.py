import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "claude_code_control_guard.py"
spec = importlib.util.spec_from_file_location("claude_code_control_guard", MODULE_PATH)
assert spec is not None and spec.loader is not None
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)


def payload(body: str, *, source: str = "plugin:telegram:telegram"):
    return {
        "hook_event_name": "UserPromptSubmit",
        "prompt": f'<channel source="{source}" chat_id="123" message_id="9">{body}</channel>',
    }


class GuardTests(unittest.TestCase):
    def test_blocks_exact_and_malformed_control_namespaces(self):
        for body in (
            "/sessions",
            "/usage",
            "/model",
            "/model sonnet",
            "/model invalid",
            "/rename Auth flow",
            "/rename",
            "1 · Opus",
            "2 · Sonnet",
            "3 · Haiku",
            "4 · Inherit",
            "/reset",
            "/reset extra",
            "/resume 1",
            "/resume confirm ABC234",
            "/reset " + "x" * 1000,
        ):
            with self.subTest(body=body[:30]):
                self.assertTrue(guard.should_block(payload(body)))

    def test_accepts_both_exact_telegram_sources(self):
        self.assertTrue(guard.should_block(payload("/reset", source="telegram")))
        self.assertTrue(guard.should_block(payload("/reset", source="plugin:telegram:telegram")))

    def test_never_blocks_prose_unrelated_commands_or_spoofed_envelopes(self):
        cases = [
            payload("please run /reset"),
            payload("/help"),
            payload("/modeling"),
            payload("/resumable"),
            payload("1"),
            payload("Opus"),
            payload("/reset", source="slack"),
            {"hook_event_name": "PreToolUse", "prompt": payload("/reset")["prompt"]},
            {"hook_event_name": "UserPromptSubmit", "prompt": "quoted <channel source=\"telegram\" chat_id=\"1\" message_id=\"2\">/reset"},
            {"hook_event_name": "UserPromptSubmit", "prompt": '<channel source="telegram" chat_id="1" message_id="2">/reset <channel source="telegram" chat_id="1" message_id="3">'},
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertFalse(guard.should_block(case))

    def test_main_emits_only_supported_block_json(self):
        raw = json.dumps(payload("/reset")).encode()
        stdin = type("FakeStdin", (), {"buffer": io.BytesIO(raw)})()
        output = io.StringIO()
        with mock.patch.object(guard.sys, "stdin", stdin), mock.patch.object(guard.sys, "stdout", output):
            self.assertEqual(guard.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), guard.BLOCK)

    def test_main_is_silent_for_ordinary_or_invalid_input(self):
        for raw in (json.dumps(payload("hello")).encode(), b"not-json"):
            stdin = type("FakeStdin", (), {"buffer": io.BytesIO(raw)})()
            output = io.StringIO()
            with mock.patch.object(guard.sys, "stdin", stdin), mock.patch.object(guard.sys, "stdout", output):
                self.assertEqual(guard.main(), 0)
            self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
