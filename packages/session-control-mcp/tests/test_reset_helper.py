import importlib.util
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

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
    def test_fresh_unit_replaces_continue_with_exact_session_id_and_local_bootstrap(self):
        unit = reset.fresh_unit_from_continue(BASE_UNIT, NEW_SESSION)
        expected = BASE_UNIT.replace("--continue", f"--session-id {NEW_SESSION}").replace(
            '" /dev/null',
            f" {reset.LOCAL_CHANNEL_BOOTSTRAP_COMMAND}\" /dev/null",
        )
        # /agents is handled locally by Claude Code: it starts Channel plumbing, returns to
        # the prompt, calls no LLM, and native ai-title ignores its local-command records.
        self.assertEqual(unit, expected)
        self.assertNotIn("--continue", unit)
        self.assertNotIn("READY", unit)

    def test_resume_unit_targets_exact_old_session_without_prompt(self):
        unit = reset.resume_unit_from_continue(BASE_UNIT, OLD_SESSION)
        self.assertEqual(unit, BASE_UNIT.replace("--continue", f"--resume {OLD_SESSION}"))
        self.assertNotIn("--continue", unit)

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
                "session_start_receipt_dir": "/srv/claude-state/receipts",
                "model_env_file": "/etc/claude-code-telegram-kit/model.env",
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
            self.assertEqual(config.session_start_receipt_dir, Path("/srv/claude-state/receipts"))
            self.assertEqual(config.required_process_markers, tuple(data["required_process_markers"]))

            data["model_env_file"] = "/etc/claude-code-telegram-kit/../shadow"
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "must be /etc/claude-code-telegram-kit/model.env"):
                reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid())
            data["model_env_file"] = "/etc/claude-code-telegram-kit/model.env"
            path.write_text(json.dumps(data))

            os.chmod(path, 0o600)
            self.assertEqual(
                reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid()).service_name,
                "my-claude.service",
            )
            os.chmod(path, 0o640)
            with self.assertRaisesRegex(ValueError, "0600 or 0644"):
                reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid())

    def test_rejects_unknown_config_fields(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "reset.json"
            path.write_text(json.dumps({"unknown": True}))
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, "unknown config fields"):
                reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid())

    def test_requires_the_session_start_receipt_directory(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "reset.json"
            data = {
                "service_name": "my-claude.service",
                "service_user": "tester",
                "workspace": "/srv/claude-bot",
                "project_sessions": "/srv/claude-state/sessions",
                "channel_state": "/srv/claude-state/telegram",
                "lock_path": "/run/lock/my-claude-reset.lock",
                "poller_process_marker": "bun server.ts",
                "required_process_markers": ["renderer", "control"],
            }
            path.write_text(json.dumps(data))
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, "missing config fields"):
                reset.load_config(path, expected_uid=os.getuid(), user_lookup=lambda _name: os.getuid())

    def test_rejects_a_relative_session_start_receipt_directory(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "reset.json"
            data = {
                "service_name": "my-claude.service",
                "service_user": "tester",
                "workspace": "/srv/claude-bot",
                "project_sessions": "/srv/claude-state/sessions",
                "session_start_receipt_dir": "relative/receipts",
                "model_env_file": "/etc/claude-code-telegram-kit/model.env",
                "channel_state": "/srv/claude-state/telegram",
                "lock_path": "/run/lock/my-claude-reset.lock",
                "poller_process_marker": "bun server.ts",
                "required_process_markers": ["renderer", "control"],
            }
            path.write_text(json.dumps(data))
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, "must be absolute"):
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

class NotificationTransportTests(unittest.TestCase):
    class FakeResponse:
        def __init__(self, body: bytes):
            self.body = body
            self.read_sizes = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size=-1):
            self.read_sizes.append(size)
            return self.body if size < 0 else self.body[:size]

    class FakeOpener:
        def __init__(self, response):
            self.response = response
            self.calls = []

        def open(self, request, timeout):
            self.calls.append((request, timeout))
            return self.response

    def test_notify_uses_no_redirect_opener_and_bounded_read(self):
        body = json.dumps({"ok": True, "result": {"message_id": 71}}).encode()
        response = self.FakeResponse(body)
        opener = self.FakeOpener(response)
        with mock.patch.object(reset.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(reset._notify(
                TEST_TOKEN, TEST_CHAT_ID, "<b>done</b>", parse_mode="HTML"
            ), 71)
        handler = build.call_args.args[0]
        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "https://example.invalid"))
        self.assertEqual(response.read_sizes, [reset.MAX_TELEGRAM_RESPONSE_BYTES + 1])
        self.assertEqual(opener.calls[0][1], 20)
        self.assertEqual(json.loads(opener.calls[0][0].data), {
            "chat_id": TEST_CHAT_ID,
            "text": "<b>done</b>",
            "parse_mode": "HTML",
        })

    def test_notify_rejects_oversized_response_before_json_parse(self):
        response = self.FakeResponse(b"x" * (reset.MAX_TELEGRAM_RESPONSE_BYTES + 1))
        opener = self.FakeOpener(response)
        with mock.patch.object(reset.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "response too large"):
                reset._notify(TEST_TOKEN, TEST_CHAT_ID, "done")

    def test_notify_rejects_nonpositive_or_noninteger_message_receipts(self):
        for message_id in (0, -1, True, "71"):
            body = json.dumps({"ok": True, "result": {"message_id": message_id}}).encode()
            opener = self.FakeOpener(self.FakeResponse(body))
            with mock.patch.object(reset.urllib.request, "build_opener", return_value=opener):
                with self.assertRaisesRegex(RuntimeError, "notification failed"):
                    reset._notify(TEST_TOKEN, TEST_CHAT_ID, "done")


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

    def test_request_receipt_retention_and_capacity_are_bounded(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            now = reset.REQUEST_RETENTION_SECONDS + 10
            state.chmod(0o700)
            for index in range(3):
                request_id = f"{index:024x}"
                path = state / f"{request_id}.json"
                path.write_text(json.dumps({"request_id": request_id, "updated_at": 0}))
                path.chmod(0o600)
            (state / f".{('f' * 24)}.tmp.{('e' * 32)}").write_text("stale")
            reset._prune_request_receipts(
                state, expected_uid=os.getuid(), now=now, retention_seconds=reset.REQUEST_RETENTION_SECONDS, max_entries=2,
            )
            self.assertEqual(list(state.iterdir()), [])

            for index in range(2):
                request_id = f"{index:024x}"
                path = state / f"{request_id}.json"
                path.write_text(json.dumps({"request_id": request_id, "updated_at": now}))
                path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, "capacity"):
                reset._prune_request_receipts(state, expected_uid=os.getuid(), now=now, max_entries=2)

    def test_request_receipt_binds_action_and_target(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            request_id = "d" * 24
            first = reset.claim_request(state, request_id, TEST_CHAT_ID, action="resume",
                                        target_session=OLD_SESSION, expected_uid=os.getuid())
            self.assertTrue(first["claimed"])
            duplicate = reset.claim_request(state, request_id, TEST_CHAT_ID, action="resume",
                                            target_session=OLD_SESSION, expected_uid=os.getuid())
            self.assertFalse(duplicate["claimed"])
            self.assertEqual(duplicate["receipt"]["status"], "in_progress")
            with self.assertRaisesRegex(ValueError, "does not match"):
                reset.claim_request(state, request_id, TEST_CHAT_ID, action="reset",
                                    target_session=None, expected_uid=os.getuid())
            with self.assertRaisesRegex(ValueError, "does not match"):
                reset.claim_request(state, request_id, TEST_CHAT_ID, action="resume",
                                    target_session=NEW_SESSION, expected_uid=os.getuid())



def _make_config(root: Path, **overrides):
    defaults = dict(
        service_name="claude-telegram.service",
        service_user="tester",
        service_uid=os.getuid(),
        workspace=root / "workspace",
        project_sessions=root / "sessions",
        session_start_receipt_dir=root / "receipts",
        model_env_file=Path("/etc/claude-code-telegram-kit/model.env"),
        channel_state=root / "state",
        lock_path=root / "lock",
        poller_process_marker="bun server.ts",
        required_process_markers=("renderer", "control"),
        allow_multiple_chats=False,
    )
    defaults.update(overrides)
    return reset.ResetConfig(**defaults)


def _write_transcript(directory: Path, session_id: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.jsonl"
    path.write_text(json.dumps({"type": "mode", "sessionId": session_id}) + "\n")
    os.chmod(path, 0o600)
    return path


def _receipt_payload(session_id: str, overrides=None):
    payload = {
        "protocol": reset.PROTOCOL_VERSION,
        "version": reset.RECEIPT_VERSION,
        "event": "SessionStart",
        "source": "startup",
        "session_id": session_id,
        "cwd": "/srv/claude-bot",
        "transcript_path": f"/home/USER/.claude/projects/srv-claude-bot/{session_id}.jsonl",
    }
    if overrides:
        payload.update(overrides)
    return payload


def _write_receipt(directory: Path, session_id: str, overrides=None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.json"
    path.write_text(json.dumps(_receipt_payload(session_id, overrides), sort_keys=True) + "\n")
    os.chmod(path, 0o600)
    return path


class TitleSessionTests(unittest.TestCase):
    def _title_assets(self, root: Path, home: Path):
        bun = home / ".bun/bin/bun"
        bun.parent.mkdir(parents=True)
        bun.write_bytes(b"fake-bun-runtime")
        bun.chmod(0o755)
        worker = root / "session-title-worker.js"
        worker.write_bytes(b"immutable-worker")
        manifest = root / "installed.json"
        manifest.write_text(json.dumps({
            "commit": "a" * 40,
            "service_user": "tester",
            "bun": {"path": str(bun), "sha256": hashlib.sha256(bun.read_bytes()).hexdigest(), "mode": "0755"},
            "backup": "/var/lib/claude-code-telegram-kit/root-assets/backups/previous",
            "assets": [{"destination": str(worker), "sha256": hashlib.sha256(worker.read_bytes()).hexdigest(), "mode": "0o444"}],
        }))
        return bun, worker, manifest

    def test_passes_only_allowlisted_auth_to_the_dropped_worker(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            _write_transcript(config.project_sessions, NEW_SESSION)
            bun, worker, manifest = self._title_assets(Path(td), Path(td) / "home")
            account = SimpleNamespace(pw_dir=str(Path(td) / "home"), pw_gid=os.getgid())
            completed = subprocess.CompletedProcess([], 0, b"", b"")
            with mock.patch.object(reset.os, "geteuid", return_value=0), \
                    mock.patch.object(reset.pwd, "getpwnam", return_value=account), \
                    mock.patch.object(reset, "_secure_regular_file", return_value=os.stat(bun)), \
                    mock.patch.object(reset, "_read_secure_regular", return_value=manifest.read_text()), \
                    mock.patch.object(reset, "ROOT_ASSET_MANIFEST", manifest), \
                    mock.patch.object(reset, "TITLE_WORKER_PATH", worker), \
                    mock.patch.object(reset.subprocess, "run", return_value=completed) as run, \
                    mock.patch.dict(reset.os.environ, {
                        "CLAUDE_CODE_OAUTH_TOKEN": "opaque-test-token",
                        "SHOULD_NOT_COPY": "private"
                    }, clear=True):
                result = reset.title_session(config, session_id=NEW_SESSION, timeout=30)
            self.assertEqual(result["status"], "title_complete")
            argv = run.call_args.args[0]
            kwargs = run.call_args.kwargs
            self.assertEqual(argv[-1], NEW_SESSION)
            self.assertEqual(argv[1], str(worker))
            self.assertTrue(argv[0].startswith("/proc/self/fd/"))
            self.assertEqual(kwargs["env"]["CLAUDE_CODE_OAUTH_TOKEN"], "opaque-test-token")
            self.assertNotIn("SHOULD_NOT_COPY", kwargs["env"])
            self.assertIsNotNone(kwargs["preexec_fn"])

    def test_refuses_to_start_without_an_authenticated_title_source(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            _write_transcript(config.project_sessions, NEW_SESSION)
            bun, worker, manifest = self._title_assets(Path(td), Path(td) / "home")
            account = SimpleNamespace(pw_dir=str(Path(td) / "home"), pw_gid=os.getgid())
            with mock.patch.object(reset.os, "geteuid", return_value=0), \
                    mock.patch.object(reset.pwd, "getpwnam", return_value=account), \
                    mock.patch.object(reset, "_secure_regular_file", return_value=os.stat(bun)), \
                    mock.patch.object(reset, "_read_secure_regular", return_value=manifest.read_text()), \
                    mock.patch.object(reset, "ROOT_ASSET_MANIFEST", manifest), \
                    mock.patch.object(reset, "TITLE_WORKER_PATH", worker), \
                    mock.patch.object(reset.subprocess, "run") as run, \
                    mock.patch.dict(reset.os.environ, {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "authenticated title source"):
                    reset.title_session(config, session_id=NEW_SESSION, timeout=30)
            run.assert_not_called()


class ProtocolTests(unittest.TestCase):
    def test_capabilities_declare_the_current_protocol_and_actions(self):
        capabilities = reset.capabilities()
        self.assertEqual(capabilities["protocol"], reset.PROTOCOL_VERSION)
        self.assertEqual(reset.PROTOCOL_VERSION, 6)
        self.assertEqual(sorted(capabilities["actions"]), ["model", "reset", "resume", "title"])
        self.assertEqual(capabilities["models"], ["opus", "sonnet", "haiku", "inherit"])

    def test_capabilities_flag_prints_json_and_exits_zero_without_config(self):
        import io
        from contextlib import redirect_stdout

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = reset.main(["--capabilities"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload["protocol"], 6)
        self.assertIn("model", payload["actions"])

    def test_rejects_non_finite_or_unbounded_operation_timeout(self):
        for value in ("0", "-1", "301", "inf", "nan"):
            with self.subTest(value=value):
                self.assertEqual(reset.main(["--timeout", value]), 1)

    def test_capabilities_never_mutates_state(self):
        import io
        from contextlib import redirect_stdout

        with mock.patch.object(reset, "reset_session") as reset_call, \
                mock.patch.object(reset, "resume_session") as resume_call, \
                mock.patch.object(reset, "load_config") as load:
            with redirect_stdout(io.StringIO()):
                reset.main(["--capabilities"])
        reset_call.assert_not_called()
        resume_call.assert_not_called()
        load.assert_not_called()

    def test_rejects_an_unknown_protocol_before_doing_anything(self):
        with mock.patch.object(reset, "load_config") as load:
            self.assertEqual(reset.main(["--protocol", "3", "--action", "reset"]), 1)
        load.assert_not_called()

    def test_reset_and_resume_require_exact_current_session_identity(self):
        with mock.patch.object(reset, "load_config") as load:
            self.assertEqual(reset.main(["--action", "reset"]), 1)
            self.assertEqual(reset.main(["--action", "reset", "--current-session-id", "not-a-uuid"]), 1)
            self.assertEqual(reset.main(["--action", "reset", "--session-id", NEW_SESSION,
                                         "--current-session-id", OLD_SESSION]), 1)
            self.assertEqual(reset.main(["--action", "resume"]), 1)
            self.assertEqual(reset.main(["--action", "resume", "--session-id", "not-a-uuid"]), 1)
        load.assert_not_called()

    def test_rejects_a_model_argument_on_non_model_actions(self):
        with mock.patch.object(reset, "load_config") as load:
            self.assertEqual(reset.main(["--action", "reset", "--model", "sonnet"]), 1)
            self.assertEqual(reset.main([
                "--action", "resume",
                "--session-id", NEW_SESSION,
                "--current-session-id", OLD_SESSION,
                "--model", "sonnet",
            ]), 1)
        load.assert_not_called()

    def test_resume_requires_and_validates_the_current_session_id(self):
        with mock.patch.object(reset, "load_config") as load:
            self.assertEqual(reset.main(["--action", "resume", "--session-id", OLD_SESSION]), 1)
            self.assertEqual(
                reset.main(["--action", "resume", "--session-id", OLD_SESSION,
                            "--current-session-id", "not-a-uuid"]), 1)
            self.assertEqual(
                reset.main(["--action", "resume", "--session-id", "not-a-uuid",
                            "--current-session-id", NEW_SESSION]), 1)
        load.assert_not_called()

    def test_reset_invocation_forwards_the_exact_current_session(self):
        with mock.patch.object(reset, "load_config", return_value="cfg") as load, \
                mock.patch.object(reset, "reset_session", return_value={"status": "reset_complete"}) as run:
            self.assertEqual(reset.main(["--config", "/tmp/x.json", "--current-session-id", OLD_SESSION]), 0)
        load.assert_called_once()
        self.assertEqual(run.call_args.kwargs["current_session_id"], OLD_SESSION)
        self.assertEqual(run.call_args.kwargs["chat_id"], None)
        self.assertEqual(run.call_args.kwargs["request_id"], None)


class SelectedSessionValidationTests(unittest.TestCase):
    def test_accepts_an_owned_regular_transcript_in_the_configured_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = _make_config(root)
            _write_transcript(config.project_sessions, OLD_SESSION)
            path = reset.validate_selected_session(config, OLD_SESSION)
            self.assertEqual(path, config.project_sessions / f"{OLD_SESSION}.jsonl")

    def test_rejects_a_non_uuid_traversal_or_absolute_selection(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            config.project_sessions.mkdir(parents=True)
            for bad in ["../../etc/passwd", "/etc/passwd", "not-a-uuid", "", f"{OLD_SESSION}.jsonl"]:
                with self.assertRaises(ValueError):
                    reset.validate_selected_session(config, bad)

    def test_rejects_missing_symlinked_and_wrongly_owned_transcripts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = _make_config(root)
            real = _write_transcript(config.project_sessions, OLD_SESSION)
            os.symlink(real, config.project_sessions / f"{NEW_SESSION}.jsonl")

            with self.assertRaises(ValueError):
                reset.validate_selected_session(config, "33333333-3333-4333-8333-333333333333")
            with self.assertRaises(ValueError):
                reset.validate_selected_session(config, NEW_SESSION)

            foreign = _make_config(root, service_uid=os.getuid() + 4242)
            with self.assertRaises(ValueError):
                reset.validate_selected_session(foreign, OLD_SESSION)

    def test_rejects_a_group_or_world_writable_transcript(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            path = _write_transcript(config.project_sessions, OLD_SESSION)
            os.chmod(path, 0o666)
            with self.assertRaises(ValueError):
                reset.validate_selected_session(config, OLD_SESSION)

    def test_rejects_a_transcript_with_an_extra_hardlink(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            path = _write_transcript(config.project_sessions, OLD_SESSION)
            os.link(path, config.project_sessions / "shadow.jsonl")
            with self.assertRaisesRegex(ValueError, "one hardlink"):
                reset.validate_selected_session(config, OLD_SESSION)


class TargetHealthTests(unittest.TestCase):
    def test_health_matches_the_exact_resume_flag_and_all_required_workers(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            commands = [
                f"claude --resume {OLD_SESSION} --channels plugin:telegram",
                "bun server.ts",
                "bun renderer",
                "bun control",
            ]
            with mock.patch.object(reset, "_run") as run, \
                    mock.patch.object(reset, "_process_rows", return_value={
                        10: (1, "main"),
                        11: (10, commands[0]),
                        12: (10, commands[1]),
                        13: (10, commands[2]),
                        14: (10, commands[3]),
                    }):
                run.return_value = subprocess.CompletedProcess([], 0, stdout="10\n", stderr="")
                self.assertTrue(reset._service_health(config, OLD_SESSION, flag="--resume"))
                self.assertFalse(reset._service_health(config, NEW_SESSION, flag="--resume"))
                self.assertFalse(reset._service_health(config, OLD_SESSION, flag="--session-id"))

    def test_health_fails_when_the_official_poller_is_missing(self):
        with tempfile.TemporaryDirectory() as td:
            config = _make_config(Path(td))
            with mock.patch.object(reset, "_run") as run, \
                    mock.patch.object(reset, "_process_rows", return_value={
                        10: (1, "main"),
                        11: (10, f"claude --resume {OLD_SESSION}"),
                        12: (10, "bun renderer"),
                        13: (10, "bun control"),
                    }):
                run.return_value = subprocess.CompletedProcess([], 0, stdout="10\n", stderr="")
                self.assertFalse(reset._service_health(config, OLD_SESSION, flag="--resume"))
                self.assertTrue(
                    reset._service_health(config, OLD_SESSION, flag="--resume", require_workers=False)
                )


class SessionStartReceiptTests(unittest.TestCase):
    def _config_with_receipt_dir(self, td: str, **overrides):
        config = _make_config(Path(td), **overrides)
        config.session_start_receipt_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        return config

    def test_read_accepts_a_secure_matching_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            _write_receipt(config.session_start_receipt_dir, NEW_SESSION)
            payload = reset._read_session_receipt(config, NEW_SESSION)
            self.assertEqual(payload["session_id"], NEW_SESSION)
            self.assertEqual(payload["event"], "SessionStart")
            self.assertEqual(payload["source"], "startup")
            self.assertEqual(payload["protocol"], reset.PROTOCOL_VERSION)
            self.assertEqual(payload["cwd"], "/srv/claude-bot")
            self.assertEqual(payload["transcript_path"], f"/home/USER/.claude/projects/srv-claude-bot/{NEW_SESSION}.jsonl")

    def test_read_returns_none_when_no_receipt_exists(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            self.assertIsNone(reset._read_session_receipt(config, NEW_SESSION))

    def test_read_rejects_a_missing_or_symlinked_receipt_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = _make_config(root)
            with self.assertRaisesRegex(ValueError, "unreadable"):
                reset._read_session_receipt(config, NEW_SESSION)

            real = root / "real"
            real.mkdir()
            os.symlink(real, root / "receipts")
            symlinked = _make_config(root, session_start_receipt_dir=root / "receipts")
            with self.assertRaisesRegex(ValueError, "real directory"):
                reset._read_session_receipt(symlinked, NEW_SESSION)

    def test_read_rejects_a_loose_or_foreign_receipt_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            loose = root / "loose"
            loose.mkdir(mode=0o755)
            foreign = root / "foreign"
            foreign.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, "0700"):
                reset._read_session_receipt(_make_config(root, session_start_receipt_dir=loose), NEW_SESSION)
            with self.assertRaisesRegex(ValueError, "service user"):
                reset._read_session_receipt(
                    _make_config(root, session_start_receipt_dir=foreign, service_uid=os.getuid() + 4242),
                    NEW_SESSION,
                )

    def test_read_rejects_a_symlinked_receipt_file(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            real = _write_receipt(config.session_start_receipt_dir, NEW_SESSION)
            real.unlink()
            os.symlink(real, config.session_start_receipt_dir / f"{NEW_SESSION}.json")
            with self.assertRaisesRegex(ValueError, "symlink"):
                reset._read_session_receipt(config, NEW_SESSION)

    def test_read_rejects_wrong_mode_owner_or_extra_hardlink(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            receipt = _write_receipt(config.session_start_receipt_dir, NEW_SESSION)
            os.chmod(receipt, 0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                reset._read_session_receipt(config, NEW_SESSION)

            os.chmod(receipt, 0o600)
            os.link(receipt, config.session_start_receipt_dir / "shadow.json")
            with self.assertRaisesRegex(ValueError, "one hardlink"):
                reset._read_session_receipt(config, NEW_SESSION)

    def test_read_rejects_wrong_protocol_event_source_or_session(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            cases = [
                ({"protocol": 2}, "wrong protocol"),
                ({"protocol": True}, "wrong protocol"),
                ({"version": 2}, "wrong version"),
                ({"event": "SessionEnd"}, "not a SessionStart"),
                ({"source": "resume"}, "not from startup"),
                ({"session_id": OLD_SESSION}, "different session"),
                ({"cwd": "/etc/../passwd"}, "traversal"),
                ({"cwd": "relative/path"}, "absolute"),
                ({"transcript_path": f"/tmp/{OLD_SESSION}.jsonl"}, "does not match"),
                ({"transcript_path": "/etc/../passwd"}, "traversal"),
                ({"extra": 1}, "unexpected fields"),
            ]
            for overrides, pattern in cases:
                with self.subTest(overrides=overrides):
                    _write_receipt(config.session_start_receipt_dir, NEW_SESSION, overrides=overrides)
                    with self.assertRaisesRegex(ValueError, pattern):
                        reset._read_session_receipt(config, NEW_SESSION)

    def test_read_rejects_an_oversized_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            _write_receipt(
                config.session_start_receipt_dir,
                NEW_SESSION,
                overrides={"cwd": "/" + ("x" * (reset.MAX_RECEIPT_BYTES + 1))},
            )
            with self.assertRaisesRegex(ValueError, "too large"):
                reset._read_session_receipt(config, NEW_SESSION)

    def test_remove_only_removes_the_expected_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            expected = _write_receipt(config.session_start_receipt_dir, NEW_SESSION)
            other = _write_receipt(config.session_start_receipt_dir, OLD_SESSION)
            stray = config.session_start_receipt_dir / "keep.txt"
            stray.write_text("unrelated\n")

            reset._remove_session_receipt(config, NEW_SESSION)

            self.assertFalse(expected.exists())
            self.assertTrue(other.exists())
            self.assertTrue(stray.exists())

    def test_remove_ignores_a_missing_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            stray = config.session_start_receipt_dir / "keep.txt"
            stray.write_text("unrelated\n")
            reset._remove_session_receipt(config, NEW_SESSION)
            self.assertTrue(stray.exists())

    def test_remove_refuses_a_mismatched_receipt_and_preserves_it(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            spoofed = _write_receipt(
                config.session_start_receipt_dir,
                NEW_SESSION,
                overrides={"session_id": OLD_SESSION},
            )
            with self.assertRaisesRegex(ValueError, "different session"):
                reset._remove_session_receipt(config, NEW_SESSION)
            self.assertTrue(spoofed.exists())

    def test_wait_for_fresh_session_requires_both_receipt_and_health(self):
        with tempfile.TemporaryDirectory() as td:
            config = self._config_with_receipt_dir(td)
            receipt = _receipt_payload(NEW_SESSION)
            with mock.patch.object(reset, "_read_session_receipt", return_value=None), \
                    mock.patch.object(reset, "_service_health", return_value=True), \
                    mock.patch.object(reset, "time") as clock:
                clock.monotonic.side_effect = [0, 0, 100, 0]
                clock.sleep.return_value = None
                with self.assertRaises(TimeoutError):
                    reset._wait_for_fresh_session(config, NEW_SESSION, timeout=1)

            with mock.patch.object(reset, "_read_session_receipt", return_value=receipt), \
                    mock.patch.object(reset, "_service_health", return_value=False), \
                    mock.patch.object(reset, "time") as clock:
                clock.monotonic.side_effect = [0, 0, 100, 0]
                clock.sleep.return_value = None
                with self.assertRaises(TimeoutError):
                    reset._wait_for_fresh_session(config, NEW_SESSION, timeout=1)

            with mock.patch.object(reset, "_read_session_receipt", return_value=receipt), \
                    mock.patch.object(reset, "_service_health", return_value=True), \
                    mock.patch.object(reset, "time") as clock:
                clock.monotonic.side_effect = [0, 0]
                clock.sleep.return_value = None
                reset._wait_for_fresh_session(config, NEW_SESSION, timeout=1)


class ResumeOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.state_root = root / "requests"
        self.config = _make_config(root, lock_path=root / "locks" / "resume.lock")
        _write_transcript(self.config.project_sessions, OLD_SESSION)
        _write_transcript(self.config.project_sessions, NEW_SESSION)
        self.writes = []

        patches = [
            mock.patch.object(reset.os, "geteuid", return_value=0),
            mock.patch.object(reset, "REQUEST_STATE_ROOT", self.state_root),
            mock.patch.object(reset, "_read_canonical_unit", return_value=BASE_UNIT),
            mock.patch.object(reset, "_atomic_write", side_effect=lambda path, content, mode=0o644: self.writes.append(content)),
            mock.patch.object(reset, "_reload_and_restart"),
            mock.patch.object(reset, "_reload_only"),
            mock.patch.object(reset, "_wait_active"),
            mock.patch.object(reset, "claim_request", side_effect=lambda *a, **k: {"claimed": True, "receipt": {}}),
            mock.patch.object(reset, "finish_request", side_effect=lambda root_, rid, status, details, **k: {
                "request_id": rid, "status": status, **details
            }),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_resume_switches_to_the_target_then_restores_steady_continue(self):
        with mock.patch.object(reset, "_service_health", return_value=True), \
                mock.patch.object(reset, "_notify", return_value=77) as notify:
            result = reset.resume_session(
                self.config, session_id=OLD_SESSION, current_session_id=NEW_SESSION, chat_id=None, request_id=None, timeout=1
            )

        self.assertEqual(result["status"], "resume_complete")
        self.assertEqual(result["new_session"], OLD_SESSION)
        self.assertEqual(len(self.writes), 2)
        self.assertIn(f"--resume {OLD_SESSION}", self.writes[0])
        self.assertEqual(self.writes[1], BASE_UNIT)
        notify.assert_not_called()
        self.assertEqual(reset._reload_and_restart.call_count, 1)
        self.assertEqual(reset._reload_only.call_count, 1)

    def test_resume_verifies_the_target_while_the_unit_still_pins_it(self):
        events: list[str] = []
        original_write = reset._atomic_write

        def recording_write(path, content, mode=0o644):
            events.append("write_canonical" if content == BASE_UNIT else "write_target")
            return original_write(path, content, mode)

        with mock.patch.object(reset, "_atomic_write", side_effect=recording_write), \
                mock.patch.object(
                    reset, "_service_health",
                    side_effect=lambda *a, **k: events.append("health") or True,
                ):
            reset.resume_session(
                self.config, session_id=OLD_SESSION, current_session_id=NEW_SESSION, chat_id=None, request_id=None, timeout=1
            )

        # The resumed process must be verified while the unit still pins `--resume <id>`.
        # The canonical `--continue` unit may only be written back afterwards; a health check
        # that ran against the steady state would never see the flag it must confirm.
        self.assertLess(events.index("health"), events.index("write_canonical"))
        self.assertGreaterEqual(events.count("health"), 1)

    def test_resume_refuses_the_currently_active_session(self):
        with mock.patch.object(reset, "_service_health", return_value=True):
            with self.assertRaises(Exception):
                reset.resume_session(
                    self.config,
                    session_id=NEW_SESSION,
                    current_session_id=NEW_SESSION,
                    chat_id=None,
                    request_id=None,
                    timeout=1,
                )
        self.assertEqual(self.writes, [])

    def test_resume_closes_the_root_receipt_when_the_target_is_already_active(self):
        with mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN), \
                mock.patch.object(reset, "_notify") as notify:
            with self.assertRaisesRegex(RuntimeError, "session resume failed") as caught:
                reset.resume_session(
                    self.config,
                    session_id=NEW_SESSION,
                    current_session_id=NEW_SESSION,
                    chat_id=TEST_CHAT_ID,
                    request_id="c" * 24,
                    timeout=1,
                )

        self.assertIsInstance(caught.exception.__cause__, ValueError)
        self.assertIn("already the active session", str(caught.exception.__cause__))

        self.assertEqual(self.writes, [])
        reset.finish_request.assert_called_once()
        self.assertEqual(reset.finish_request.call_args.args[2], "failed")
        self.assertTrue(reset.finish_request.call_args.args[3]["recovered"])
        self.assertIn("No service change was made.", notify.call_args.args[2])
        self.assertEqual(notify.call_args.kwargs["parse_mode"], "HTML")

    def test_resume_rolls_back_to_the_old_session_when_the_target_never_becomes_healthy(self):
        with mock.patch.object(reset, "_service_health", return_value=False), \
                mock.patch.object(reset, "time") as clock:
            clock.monotonic.side_effect = [0, 0, 100, 0, 100]
            clock.sleep.return_value = None
            clock.time.return_value = 0
            with self.assertRaises(RuntimeError):
                reset.resume_session(
                    self.config, session_id=OLD_SESSION, current_session_id=NEW_SESSION, chat_id=None, request_id=None, timeout=1
                )

        self.assertIn(f"--resume {OLD_SESSION}", self.writes[0])
        self.assertIn(f"--resume {NEW_SESSION}", self.writes[1])
        self.assertEqual(self.writes[-1], BASE_UNIT)

    def test_resume_notification_failure_never_rolls_back_a_successful_resume(self):
        with mock.patch.object(reset, "_service_health", return_value=True), \
                mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN), \
                mock.patch.object(reset, "_notify", side_effect=RuntimeError("telegram down")):
            result = reset.resume_session(
                self.config,
                session_id=OLD_SESSION,
                current_session_id=NEW_SESSION,
                chat_id=TEST_CHAT_ID,
                request_id="b" * 24,
                timeout=1,
            )

        self.assertEqual(result["status"], "resume_complete")
        self.assertIsNone(result["completion_message_id"])
        self.assertEqual(self.writes[-1], BASE_UNIT)
        reset.finish_request.assert_called_once()
        self.assertEqual(reset.finish_request.call_args.args[2], "complete")
        self.assertIsNone(reset.finish_request.call_args.args[3]["completion_message_id"])

    def test_resume_is_idempotent_through_the_root_request_receipt(self):
        with mock.patch.object(reset, "claim_request", return_value={
            "claimed": False,
            "receipt": {"status": "complete", "new_session": OLD_SESSION, "completion_message_id": 5},
        }), mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN), \
                mock.patch.object(reset, "_service_health", return_value=True):
            result = reset.resume_session(
                self.config,
                session_id=OLD_SESSION,
                current_session_id=NEW_SESSION,
                chat_id=TEST_CHAT_ID,
                request_id="c" * 24,
                timeout=1,
            )

        self.assertEqual(result["status"], "duplicate_request")
        self.assertEqual(self.writes, [])

    def test_resume_refuses_a_concurrent_run_through_the_global_lock(self):
        self.config.lock_path.parent.mkdir(parents=True, exist_ok=True)
        holder = os.open(self.config.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            reset.fcntl.flock(holder, reset.fcntl.LOCK_EX | reset.fcntl.LOCK_NB)
            with mock.patch.object(reset, "_service_health", return_value=True):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    reset.resume_session(
                        self.config, session_id=OLD_SESSION, current_session_id=NEW_SESSION, chat_id=None, request_id=None, timeout=1
                    )
        finally:
            os.close(holder)
        self.assertEqual(self.writes, [])

    def test_resume_requires_root(self):
        with mock.patch.object(reset.os, "geteuid", return_value=1000):
            with self.assertRaises(PermissionError):
                reset.resume_session(
                    self.config, session_id=OLD_SESSION, current_session_id=NEW_SESSION,
                    chat_id=None, request_id=None, timeout=1,
                )

    def test_resume_rejects_a_non_uuid_current_session_id(self):
        with self.assertRaisesRegex(ValueError, "invalid session UUID"):
            reset.resume_session(
                self.config, session_id=OLD_SESSION, current_session_id="not-a-uuid",
                chat_id=None, request_id=None, timeout=1,
            )
        self.assertEqual(self.writes, [])
        reset.claim_request.assert_not_called()

    def test_resume_requires_the_current_session_transcript_to_exist(self):
        with self.assertRaisesRegex(ValueError, "does not exist"):
            reset.resume_session(
                self.config,
                session_id=OLD_SESSION,
                current_session_id="33333333-3333-4333-8333-333333333333",
                chat_id=None,
                request_id=None,
                timeout=1,
            )
        self.assertEqual(self.writes, [])
        reset.claim_request.assert_not_called()

    def test_resume_uses_the_supplied_current_session_as_rollback_authority(self):
        with mock.patch.object(reset, "_service_health", return_value=True):
            result = reset.resume_session(
                self.config, session_id=OLD_SESSION, current_session_id=NEW_SESSION,
                chat_id=None, request_id=None, timeout=1,
            )
        self.assertEqual(result["old_session"], NEW_SESSION)
        self.assertEqual(result["new_session"], OLD_SESSION)

    def test_resume_receipt_failure_after_success_is_not_reclassified(self):
        with mock.patch.object(reset, "_service_health", return_value=True), \
                mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN), \
                mock.patch.object(reset, "_notify", return_value=77) as notify, \
                mock.patch.object(reset, "finish_request", side_effect=OSError("disk full")):
            result = reset.resume_session(
                self.config,
                session_id=OLD_SESSION,
                current_session_id=NEW_SESSION,
                chat_id=TEST_CHAT_ID,
                request_id="b" * 24,
                timeout=1,
            )

        self.assertEqual(result["status"], "resume_complete")
        self.assertEqual(result["new_session"], OLD_SESSION)
        self.assertFalse(result["receipt_persisted"])
        self.assertIn("disk full", result["receipt_error"])
        self.assertEqual(self.writes[-1], BASE_UNIT)
        self.assertEqual(notify.call_count, 2)
        first = notify.call_args_list[0]
        self.assertEqual(first.args[2], "<b>Session resumed</b>")
        self.assertNotIn(OLD_SESSION[:8], first.args[2])
        self.assertEqual(first.kwargs["parse_mode"], "HTML")


class ResetOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.state_root = root / "requests"
        self.config = _make_config(root, lock_path=root / "locks" / "reset.lock")
        self.config.session_start_receipt_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        _write_transcript(self.config.project_sessions, OLD_SESSION)
        self.writes = []

        patches = [
            mock.patch.object(reset.os, "geteuid", return_value=0),
            mock.patch.object(reset, "REQUEST_STATE_ROOT", self.state_root),
            mock.patch.object(reset, "_read_canonical_unit", return_value=BASE_UNIT),
            mock.patch.object(reset, "_atomic_write", side_effect=lambda path, content, mode=0o644: self.writes.append(content)),
            mock.patch.object(reset, "_reload_and_restart"),
            mock.patch.object(reset, "_reload_only"),
            mock.patch.object(reset, "_wait_for_fresh_session"),
            mock.patch.object(reset, "_service_health", return_value=True),
            mock.patch.object(reset, "claim_request", side_effect=lambda *a, **k: {"claimed": True, "receipt": {}}),
            mock.patch.object(reset, "finish_request", side_effect=lambda root_, rid, status, details, **k: {
                "request_id": rid, "status": status, **details
            }),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_recovery_proves_the_exact_old_session_and_workers(self):
        with mock.patch.object(reset, "_wait_for_resumed_session") as wait, \
                mock.patch.object(reset, "_service_health", return_value=True) as health:
            self.assertTrue(reset._recover_old(self.config, BASE_UNIT, OLD_SESSION))
        wait.assert_called_once_with(self.config, OLD_SESSION, timeout=45.0)
        health.assert_called_once_with(self.config, OLD_SESSION, flag="--resume")

    def test_reset_uses_the_exact_current_session_not_transcript_mtime(self):
        newer = _write_transcript(self.config.project_sessions, NEW_SESSION)
        os.utime(newer, (9_999_999_999, 9_999_999_999))
        with mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN), \
                mock.patch.object(reset, "_notify", return_value=77) as notify:
            result = reset.reset_session(
                self.config, current_session_id=OLD_SESSION,
                chat_id=TEST_CHAT_ID, request_id="e" * 24, timeout=1,
            )

        self.assertEqual(result["status"], "reset_complete")
        self.assertEqual(notify.call_args.args[2], "<b>Fresh session ready</b>")
        self.assertNotIn(result["new_session"][:8], notify.call_args.args[2])
        self.assertEqual(notify.call_args.kwargs["parse_mode"], "HTML")
        self.assertTrue(result["receipt_persisted"])
        self.assertEqual(result["old_session"], OLD_SESSION)
        self.assertEqual(reset.claim_request.call_args.kwargs["action"], "reset")
        self.assertIsNone(reset.claim_request.call_args.kwargs["target_session"])
        self.assertEqual(reset.finish_request.call_args.args[2], "complete")
        self.assertEqual(self.writes[0], reset.fresh_unit_from_continue(BASE_UNIT, result["new_session"]))
        self.assertEqual(self.writes[-1], BASE_UNIT)

    def test_reset_receipt_failure_after_success_is_not_reclassified(self):
        with mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN), \
                mock.patch.object(reset, "_notify", return_value=77) as notify, \
                mock.patch.object(reset, "finish_request", side_effect=OSError("disk full")):
            result = reset.reset_session(
                self.config, current_session_id=OLD_SESSION,
                chat_id=TEST_CHAT_ID, request_id="e" * 24, timeout=1,
            )

        self.assertEqual(result["status"], "reset_complete")
        self.assertFalse(result["receipt_persisted"])
        self.assertIn("disk full", result["receipt_error"])
        self.assertEqual(result["old_session"], OLD_SESSION)
        self.assertEqual(self.writes[-1], BASE_UNIT)
        self.assertEqual(notify.call_count, 2)

    def test_reset_removes_stale_receipt_before_restart_and_cleans_after_success(self):
        with mock.patch.object(reset.uuid, "uuid4", return_value=uuid.UUID(NEW_SESSION)):
            _write_receipt(self.config.session_start_receipt_dir, NEW_SESSION)
            events = []
            real_remove = reset._remove_session_receipt

            def recording_remove(config, session_id):
                events.append("remove")
                return real_remove(config, session_id)

            with mock.patch.object(reset, "_remove_session_receipt", side_effect=recording_remove), \
                    mock.patch.object(reset, "_reload_and_restart", side_effect=lambda _config: events.append("restart")):
                result = reset.reset_session(self.config, current_session_id=OLD_SESSION, chat_id=None, request_id=None, timeout=1)

        self.assertEqual(result["status"], "reset_complete")
        self.assertEqual(events, ["remove", "restart", "remove"])
        self.assertFalse((self.config.session_start_receipt_dir / f"{NEW_SESSION}.json").exists())

    def test_reset_failure_cleans_the_expected_receipt_and_rolls_back(self):
        with mock.patch.object(reset.uuid, "uuid4", return_value=uuid.UUID(NEW_SESSION)), \
                mock.patch.object(reset, "_wait_for_fresh_session", side_effect=TimeoutError("not ready")), \
                mock.patch.object(reset, "_recover_old", return_value=True) as recover:
            _write_receipt(self.config.session_start_receipt_dir, NEW_SESSION)
            with self.assertRaises(RuntimeError):
                reset.reset_session(self.config, current_session_id=OLD_SESSION, chat_id=None, request_id=None, timeout=1)

        self.assertFalse((self.config.session_start_receipt_dir / f"{NEW_SESSION}.json").exists())
        recover.assert_called_once()
        self.assertEqual(recover.call_args.args[0], self.config)
        self.assertEqual(recover.call_args.args[2], OLD_SESSION)


class ModelOrchestrationTests(unittest.TestCase):
    def test_process_environment_is_split_on_nul_boundaries(self):
        self.assertEqual(
            reset._parse_process_environment(
                b"HOME=/srv/claude\0ANTHROPIC_MODEL=sonnet\0EMPTY=\0"
            ),
            {"HOME": "/srv/claude", "ANTHROPIC_MODEL": "sonnet", "EMPTY": ""},
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.config = _make_config(
            root,
            lock_path=root / "locks" / "model.lock",
            model_env_file=root / "model.env",
        )
        self.events: list[str] = []
        patches = [
            mock.patch.object(reset.os, "geteuid", return_value=0),
            mock.patch.object(reset, "REQUEST_STATE_ROOT", root / "requests"),
            mock.patch.object(reset, "validate_notification_target", return_value=TEST_TOKEN),
            mock.patch.object(reset, "claim_request", return_value={"claimed": True, "receipt": {}}),
            mock.patch.object(reset, "_read_model_env", return_value=(True, b"ANTHROPIC_MODEL=opus\n")),
            mock.patch.object(reset, "_set_model_env", side_effect=lambda *_: self.events.append("set")),
            mock.patch.object(reset, "_restore_model_env", side_effect=lambda *_: self.events.append("restore")),
            mock.patch.object(reset, "_reload_and_restart", side_effect=lambda *_: self.events.append("restart")),
            mock.patch.object(reset, "_wait_active", side_effect=lambda *_: self.events.append("wait")),
            mock.patch.object(reset, "finish_request", return_value={}),
            mock.patch.object(reset, "_notify", return_value=77),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_model_switch_persists_restarts_verifies_and_receipts(self):
        with mock.patch.object(reset, "_service_model_health", return_value=True) as health:
            result = reset.model_session(
                self.config, model="sonnet", chat_id=TEST_CHAT_ID,
                request_id="f" * 24, timeout=1,
            )

        self.assertEqual(result["status"], "model_complete")
        self.assertEqual(result["old_model"], "opus")
        self.assertEqual(result["new_model"], "sonnet")
        self.assertEqual(reset._notify.call_args.args[2], "<b>Model switched</b>\n<code>sonnet</code>")
        self.assertEqual(reset._notify.call_args.kwargs["parse_mode"], "HTML")
        self.assertEqual(self.events, ["set", "restart"])
        health.assert_called_once_with(self.config, "sonnet")
        self.assertEqual(reset.claim_request.call_args.kwargs["action"], "model")
        self.assertEqual(reset.claim_request.call_args.kwargs["target_session"], "sonnet")
        self.assertEqual(reset.finish_request.call_args.args[2], "complete")

    def test_inherit_verifies_the_absence_of_a_bot_model_override(self):
        with mock.patch.object(reset, "_service_model_health", return_value=True) as health:
            result = reset.model_session(
                self.config, model="inherit", chat_id=TEST_CHAT_ID,
                request_id="d" * 24, timeout=1,
            )
        self.assertEqual(result["new_model"], "inherit")
        health.assert_called_once_with(self.config, None)

    def test_model_switch_rolls_back_the_previous_bytes_on_failed_health(self):
        waits = 0

        def wait_then_recover(*_args):
            nonlocal waits
            waits += 1
            self.events.append("wait")
            if waits == 1:
                raise TimeoutError("not ready")

        with mock.patch.object(reset, "_wait_model_service", side_effect=wait_then_recover):
            with self.assertRaisesRegex(RuntimeError, "verify_model_service"):
                reset.model_session(
                    self.config, model="haiku", chat_id=TEST_CHAT_ID,
                    request_id="a" * 24, timeout=1,
                )

        self.assertEqual(
            self.events,
            ["set", "restart", "wait", "restore", "restart", "wait"],
        )
        self.assertEqual(reset.finish_request.call_args.args[2], "failed")
        self.assertTrue(reset.finish_request.call_args.args[3]["recovered"])

    def test_model_read_failure_closes_receipt_without_mutating_service(self):
        reset._read_model_env.side_effect = OSError("unreadable")
        with self.assertRaisesRegex(RuntimeError, "read_model_env"):
            reset.model_session(
                self.config, model="sonnet", chat_id=TEST_CHAT_ID,
                request_id="c" * 24, timeout=1,
            )
        self.assertEqual(self.events, [])
        self.assertEqual(reset.finish_request.call_args.args[2], "failed")
        self.assertTrue(reset.finish_request.call_args.args[3]["recovered"])

    def test_model_health_wait_retries_until_workers_are_ready(self):
        with mock.patch.object(reset, "_service_model_health", side_effect=[False, True]) as health, \
                mock.patch.object(reset.time, "monotonic", side_effect=[0, 0, 0, 0.5]), \
                mock.patch.object(reset.time, "sleep") as sleep:
            reset._wait_model_service(self.config, "sonnet", timeout=1)
        self.assertEqual(health.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_model_health_wait_times_out_when_workers_never_become_ready(self):
        with mock.patch.object(reset, "_service_model_health", return_value=False), \
                mock.patch.object(reset.time, "monotonic", side_effect=[0, 0, 0, 0.25]), \
                mock.patch.object(reset.time, "sleep") as sleep:
            with self.assertRaisesRegex(TimeoutError, "model service did not become healthy"):
                reset._wait_model_service(self.config, "sonnet", timeout=0.25)
        sleep.assert_called_once_with(0.25)

    def test_model_health_requires_the_actual_claude_cli_environment(self):
        rows = {
            101: (100, "/usr/bin/script -qefc /opt/claude/bin/claude --continue"),
            102: (101, "/opt/claude/bin/claude --continue --channels plugin:telegram@claude-plugins-official"),
            103: (102, "bun server.ts"),
            104: (102, "bun renderer"),
            105: (102, "bun control"),
        }

        def run(argv, **_kwargs):
            return SimpleNamespace(stdout="100\n" if "show" in argv else "")

        with mock.patch.object(reset, "_run", side_effect=run), \
                mock.patch.object(reset, "_process_rows", return_value=rows), \
                mock.patch.object(reset, "_process_uid", return_value=self.config.service_uid), \
                mock.patch.object(
                    reset,
                    "_read_process_environment",
                    side_effect=lambda pid: {"ANTHROPIC_MODEL": "sonnet"} if pid == 101 else {},
                ):
            self.assertFalse(reset._service_model_health(self.config, "sonnet"))

        with mock.patch.object(reset, "_run", side_effect=run), \
                mock.patch.object(reset, "_process_rows", return_value=rows), \
                mock.patch.object(reset, "_process_uid", return_value=self.config.service_uid), \
                mock.patch.object(
                    reset,
                    "_read_process_environment",
                    side_effect=lambda pid: {"ANTHROPIC_MODEL": "sonnet"} if pid == 102 else {},
                ):
            self.assertTrue(reset._service_model_health(self.config, "sonnet"))

    def test_model_replay_never_mutates_the_service(self):
        reset.claim_request.return_value = {
            "claimed": False,
            "receipt": {"status": "complete", "new_model": "sonnet"},
        }
        result = reset.model_session(
            self.config, model="sonnet", chat_id=TEST_CHAT_ID,
            request_id="b" * 24, timeout=1,
        )
        self.assertEqual(result["status"], "duplicate_request")
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()
