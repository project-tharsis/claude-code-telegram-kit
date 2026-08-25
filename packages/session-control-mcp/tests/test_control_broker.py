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
        caps = {"protocol": broker.HELPER_PROTOCOL, "actions": ["reset", "resume", "model", "title"], "models": ["opus", "sonnet", "haiku", "inherit"], "helper": "claude-code-session-reset"}
        run = Runner(json.dumps(caps))
        result = request({"protocol": broker.BROKER_PROTOCOL, "action": "capabilities"}, run)
        self.assertEqual(result, {"status": "ok", "capabilities": caps})
        self.assertEqual(run.calls, [(["/usr/local/sbin/fixed-helper", "--capabilities"], 5.0)])

    def test_reset_builds_one_fixed_no_shell_systemd_command(self):
        run = Runner()
        result = request({"protocol": broker.BROKER_PROTOCOL, "action": "reset", "chat_id": "123", "message_id": "51", "current_session_id": SESSION}, run)
        argv, timeout = run.calls[0]
        self.assertEqual(timeout, 10.0)
        self.assertEqual(argv[0], "/usr/bin/systemd-run")
        self.assertNotIn("sudo", " ".join(argv))
        self.assertEqual(argv[2:5], ["--collect", "--no-block", "/usr/local/sbin/fixed-helper"])
        self.assertRegex(result["unit"], r"^claude-session-reset-[0-9a-f]{24}$")

    def test_resume_and_model_carry_only_allowlisted_values(self):
        resume = Runner()
        request({"protocol": broker.BROKER_PROTOCOL, "action": "resume", "chat_id": "123", "message_id": "51", "current_session_id": SESSION, "session_id": SESSION}, resume)
        self.assertIn("--current-session-id", resume.calls[0][0])
        model = Runner()
        request({"protocol": broker.BROKER_PROTOCOL, "action": "model", "chat_id": "123", "message_id": "52", "model": "sonnet"}, model)
        self.assertIn("sonnet", model.calls[0][0])

    def test_title_is_a_fixed_authenticated_one_shot_job(self):
        run = Runner()
        result = request({"protocol": broker.BROKER_PROTOCOL, "action": "title", "session_id": SESSION}, run)
        argv, timeout = run.calls[0]
        self.assertEqual(timeout, 10.0)
        self.assertEqual(argv[0], "/usr/bin/systemd-run")
        self.assertIn(f"--property=EnvironmentFile={broker.TITLE_OAUTH_ENV_FILE}", argv)
        self.assertEqual(argv[3:6], ["--collect", "--no-block", "/usr/local/sbin/fixed-helper"])
        self.assertEqual(argv[argv.index("--action") + 1], "title")
        self.assertEqual(argv[argv.index("--session-id") + 1], SESSION)
        self.assertRegex(result["unit"], r"^claude-session-title-[0-9a-f]{24}$")

    def test_title_verifies_the_fixed_root_owned_oauth_environment(self):
        run = Runner()
        with mock.patch.object(broker, "_secure_file") as secure:
            broker.process_request(
                json.dumps({"protocol": broker.BROKER_PROTOCOL, "action": "title", "session_id": SESSION}).encode(),
                os.getuid(),
                config_path=Path("/etc/fixed-reset.json"),
                helper=Path("/usr/local/sbin/fixed-helper"),
                run=run,
                reserve=lambda _runner: None,
                service_uid=os.getuid(),
                verify_files=True,
            )
        secure.assert_any_call(Path("/usr/local/sbin/fixed-helper"), (0o755,), "reset helper")
        secure.assert_any_call(broker.TITLE_OAUTH_ENV_FILE, (0o600,), "title OAuth environment")

    def test_memory_review_is_a_fixed_authenticated_one_shot_job(self):
        run = Runner()
        result = request({"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": SESSION, "prompt_id": "prompt-1"}, run)
        argv, timeout = run.calls[0]
        self.assertEqual(timeout, 10.0)
        self.assertEqual(argv[0], "/usr/bin/systemd-run")
        self.assertIn(f"--property=EnvironmentFile={broker.TITLE_OAUTH_ENV_FILE}", argv)
        self.assertEqual(argv[3:6], ["--collect", "--no-block", "/usr/local/sbin/fixed-helper"])
        self.assertEqual(argv[argv.index("--action") + 1], "memory-review")
        self.assertEqual(argv[argv.index("--session-id") + 1], SESSION)
        self.assertEqual(argv[argv.index("--prompt-id") + 1], "prompt-1")
        self.assertNotIn("--chat-id", argv)
        self.assertNotIn("--request-id", argv)
        self.assertRegex(result["unit"], r"^claude-session-memory-review-[0-9a-f]{24}$")

    def test_memory_review_verifies_the_fixed_root_owned_oauth_environment(self):
        run = Runner()
        with mock.patch.object(broker, "_secure_file") as secure:
            broker.process_request(
                json.dumps({"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": SESSION, "prompt_id": "prompt-1"}).encode(),
                os.getuid(),
                config_path=Path("/etc/fixed-reset.json"),
                helper=Path("/usr/local/sbin/fixed-helper"),
                run=run,
                reserve=lambda _runner: None,
                service_uid=os.getuid(),
                verify_files=True,
            )
        secure.assert_any_call(Path("/usr/local/sbin/fixed-helper"), (0o755,), "reset helper")
        secure.assert_any_call(broker.TITLE_OAUTH_ENV_FILE, (0o600,), "title OAuth environment")

    def test_memory_review_rejects_extra_fields_and_malformed_identity(self):
        run = Runner()
        bad = [
            {"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": SESSION, "prompt_id": "prompt-1", "chat_id": "123"},
            {"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": "not-a-uuid", "prompt_id": "prompt-1"},
            {"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": SESSION, "prompt_id": "../../etc/passwd"},
            {"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": SESSION},
        ]
        for payload in bad:
            with self.assertRaises((ValueError, KeyError)):
                request(payload, run)
        self.assertEqual(run.calls, [])

    def test_rejects_malformed_capability_shapes_and_root_path_flags(self):
        for payload in (
            '{"protocol":5,"protocol":5,"actions":["reset","resume","model"],"models":["opus","sonnet","haiku","inherit"],"helper":"x"}',
            '{"protocol":5,"actions":["reset","resume","model"],"models":["opus","sonnet","haiku","inherit"],"helper":"x","extra":true}',
        ):
            run = Runner(stdout=payload)
            with self.assertRaises(ValueError):
                request({"protocol": broker.BROKER_PROTOCOL, "action": "capabilities"}, run)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            broker.main(["--helper", "/tmp/other"])

    def test_rejects_wrong_peer_extra_keys_paths_and_invalid_values(self):
        run = Runner()
        with self.assertRaises(PermissionError):
            broker.process_request(b'{"protocol":2,"action":"capabilities"}', os.getuid() + 1, run=run, service_uid=os.getuid(), verify_files=False)
        bad = [
            {"protocol": broker.BROKER_PROTOCOL, "action": "reset", "chat_id": "123", "message_id": "51", "current_session_id": SESSION, "command": "id"},
            {"protocol": broker.BROKER_PROTOCOL, "action": "model", "chat_id": "123", "message_id": "51", "model": "other"},
            {"protocol": broker.BROKER_PROTOCOL, "action": "resume", "chat_id": "123", "message_id": "51", "current_session_id": "bad", "session_id": SESSION},
            {"protocol": broker.BROKER_PROTOCOL, "action": "reset", "chat_id": "-1", "message_id": "51", "current_session_id": SESSION},
            {"protocol": broker.BROKER_PROTOCOL, "action": "reset", "chat_id": "١٢٣", "message_id": "51", "current_session_id": SESSION},
            {"protocol": broker.BROKER_PROTOCOL, "action": "reset", "chat_id": "123", "message_id": "51", "current_session_id": "bad"},
        ]
        for payload in bad:
            with self.assertRaises((ValueError, KeyError)):
                request(payload, run)
        for raw in (
            b'{"protocol":2,"protocol":2,"action":"capabilities"}',
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
            pending_argv = pending.calls[0][0]
            self.assertIn("claude-session-reset*.service", pending_argv)
            self.assertIn("claude-session-title*.service", pending_argv)
            # The default (interactive) pending-job query must never fold memory-review units
            # into the same budget -- see test_memory_review_jobs_have_their_own_separate_quota
            # and test_memory_review_pressure_never_starves_interactive_commands below.
            self.assertNotIn("claude-session-memory-review*.service", pending_argv)

    def test_memory_review_jobs_have_their_own_separate_quota(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "rate.json"
            pending = Runner(stdout="a\nb\n")
            with self.assertRaisesRegex(RuntimeError, "memory review"):
                broker._reserve_mutation(pending, action="memory-review", state_path=state, now=100.0, expected_uid=os.getuid())
            pending_argv = pending.calls[0][0]
            self.assertIn("claude-session-memory-review*.service", pending_argv)
            self.assertNotIn("claude-session-reset*.service", pending_argv)
            self.assertNotIn("claude-session-title*.service", pending_argv)

    def test_memory_review_pressure_never_starves_interactive_commands(self):
        # A burst of pending automatic memory-review jobs (well past MAX_PENDING_JOBS) must
        # never cause a concurrent, user-initiated reset/resume/model/title request to be
        # rejected: the two quotas are partitioned, not shared from one pool. Unlike the plain
        # Runner (which ignores argv and always returns its fixed stdout), this fake actually
        # filters by the unit-glob patterns systemctl was asked for, so it can distinguish "the
        # interactive query saw memory-review units" from "it correctly never asked for them."
        units = [f"claude-session-memory-review-{i}.service" for i in range(10)]

        class FilteringRunner(Runner):
            def __call__(self, argv: list[str], timeout: float):
                self.calls.append((argv, timeout))
                patterns = argv[argv.index("--plain") + 1:]
                matched = [unit for unit in units for pattern in patterns if Path(unit).match(pattern)]
                return subprocess.CompletedProcess(argv, 0, "\n".join(matched) + ("\n" if matched else ""), "")

        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "rate.json"
            run = FilteringRunner()
            broker._reserve_mutation(run, action="reset", state_path=state, now=100.0, expected_uid=os.getuid())
            pending_argv = run.calls[0][0]
            self.assertNotIn("claude-session-memory-review*.service", pending_argv)

    def test_process_request_threads_the_action_into_the_default_reserve_end_to_end(self):
        # process_request's default (reserve=None) path must bind the actual request action into
        # _reserve_mutation, not always fall back to the interactive quota. A memory-review
        # request should be counted and rejected against the memory-review quota even though a
        # burst of pending memory-review units would never trip the interactive one.
        heavy = Runner(stdout="\n".join(f"claude-session-memory-review-{i}.service" for i in range(10)) + "\n")
        with self.assertRaisesRegex(RuntimeError, "memory review"):
            broker.process_request(
                json.dumps({"protocol": broker.BROKER_PROTOCOL, "action": "memory-review", "session_id": SESSION, "prompt_id": "prompt-1"}).encode(),
                os.getuid(),
                config_path=Path("/etc/fixed-reset.json"),
                helper=Path("/usr/local/sbin/fixed-helper"),
                run=heavy,
                service_uid=os.getuid(),
                verify_files=False,
            )
        pending_argv = heavy.calls[0][0]
        self.assertIn("claude-session-memory-review*.service", pending_argv)
        self.assertNotIn("claude-session-reset*.service", pending_argv)

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
