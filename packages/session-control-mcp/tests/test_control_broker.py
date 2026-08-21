from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "claude_code_control_broker.py"
SPEC = importlib.util.spec_from_file_location("control_broker", SCRIPT)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)
SESSION = "3fcbaf06-4378-4339-b026-8c2e026a65e7"


class Runner:
    def __init__(self, stdout: str = "", returncode: int = 0):
        self.stdout = stdout
        self.returncode = returncode
        self.calls: list[tuple[list[str], float]] = []

    def __call__(self, argv: list[str], timeout: float):
        self.calls.append((argv, timeout))
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, "")


def request(payload: dict, run: Runner):
    return broker.process_request(
        json.dumps(payload).encode(),
        os.getuid(),
        config_path=Path("/etc/fixed-reset.json"),
        helper=Path("/usr/local/sbin/fixed-helper"),
        run=run,
        reserve=lambda _runner: None,
        service_uid=os.getuid(),
        verify_files=False,
    )


class ControlBrokerTests(unittest.TestCase):
    def test_capabilities_uses_only_the_fixed_helper(self):
        caps = {"protocol": 4, "actions": ["reset", "resume", "model"], "models": ["opus", "sonnet", "haiku", "inherit"], "helper": "claude-code-session-reset"}
        run = Runner(json.dumps(caps))
        result = request({"protocol": 1, "action": "capabilities"}, run)
        self.assertEqual(result, {"status": "ok", "capabilities": caps})
        self.assertEqual(run.calls, [(["/usr/local/sbin/fixed-helper", "--capabilities"], 5.0)])

    def test_reset_builds_one_fixed_no_shell_systemd_command(self):
        run = Runner()
        result = request({"protocol": 1, "action": "reset", "chat_id": "123", "message_id": "51"}, run)
        argv, timeout = run.calls[0]
        self.assertEqual(timeout, 10.0)
        self.assertEqual(argv[0], "/usr/bin/systemd-run")
        self.assertNotIn("sudo", " ".join(argv))
        self.assertEqual(argv[2:5], ["--collect", "--no-block", "/usr/local/sbin/fixed-helper"])
        self.assertRegex(result["unit"], r"^claude-session-reset-[0-9a-f]{24}$")

    def test_resume_and_model_carry_only_allowlisted_values(self):
        resume = Runner()
        request({"protocol": 1, "action": "resume", "chat_id": "123", "message_id": "51", "current_session_id": SESSION, "session_id": SESSION}, resume)
        self.assertIn("--current-session-id", resume.calls[0][0])
        model = Runner()
        request({"protocol": 1, "action": "model", "chat_id": "123", "message_id": "52", "model": "sonnet"}, model)
        self.assertIn("sonnet", model.calls[0][0])

    def test_rejects_malformed_capability_shapes_and_root_path_flags(self):
        for payload in (
            '{"protocol":4,"protocol":4,"actions":["reset","resume","model"],"models":["opus","sonnet","haiku","inherit"],"helper":"x"}',
            '{"protocol":4,"actions":["reset","resume","model"],"models":["opus","sonnet","haiku","inherit"],"helper":"x","extra":true}',
        ):
            run = Runner(stdout=payload)
            with self.assertRaises(ValueError):
                request({"protocol": 1, "action": "capabilities"}, run)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            broker.main(["--helper", "/tmp/other"])

    def test_rejects_wrong_peer_extra_keys_paths_and_invalid_values(self):
        run = Runner()
        with self.assertRaises(PermissionError):
            broker.process_request(b'{"protocol":1,"action":"capabilities"}', os.getuid() + 1, run=run, service_uid=os.getuid(), verify_files=False)
        bad = [
            {"protocol": 1, "action": "reset", "chat_id": "123", "message_id": "51", "command": "id"},
            {"protocol": 1, "action": "model", "chat_id": "123", "message_id": "51", "model": "other"},
            {"protocol": 1, "action": "resume", "chat_id": "123", "message_id": "51", "current_session_id": "bad", "session_id": SESSION},
            {"protocol": 1, "action": "reset", "chat_id": "-1", "message_id": "51"},
            {"protocol": 1, "action": "reset", "chat_id": "١٢٣", "message_id": "51"},
        ]
        for payload in bad:
            with self.assertRaises((ValueError, KeyError)):
                request(payload, run)
        for raw in (
            b'{"protocol":1,"protocol":1,"action":"capabilities"}',
            b'{"protocol":true,"action":"capabilities"}',
        ):
            with self.assertRaises(ValueError):
                broker.process_request(
                    raw,
                    os.getuid(),
                    service_uid=os.getuid(),
                    verify_files=False,
                )
        self.assertEqual(run.calls, [])

    def test_mutation_rate_and_pending_job_budgets(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "rate.json"
            run = Runner()
            broker._reserve_mutation(run, state_path=state, now=100.0, burst=2, expected_uid=os.getuid())
            broker._reserve_mutation(run, state_path=state, now=101.0, burst=2, expected_uid=os.getuid())
            with self.assertRaisesRegex(RuntimeError, "rate"):
                broker._reserve_mutation(run, state_path=state, now=102.0, burst=2, expected_uid=os.getuid())
            pending = Runner(stdout="a\nb\nc\nd\n")
            with self.assertRaisesRegex(RuntimeError, "pending"):
                broker._reserve_mutation(pending, state_path=state, now=200.0, expected_uid=os.getuid())

    def test_rejects_root_as_the_service_user(self):
        with tempfile.TemporaryDirectory() as td:
            config = Path(td) / "reset.json"
            config.write_text('{"service_user":"rootish"}')
            with mock.patch.object(broker, "_secure_file"), \
                    mock.patch.object(broker.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=0)):
                with self.assertRaisesRegex(ValueError, "unprivileged"):
                    broker._load_service_uid(config)


if __name__ == "__main__":
    unittest.main()
