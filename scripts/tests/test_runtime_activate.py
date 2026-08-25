import importlib.util
import json
import os
import pwd
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "runtime_activate.py"
spec = importlib.util.spec_from_file_location("runtime_activate", SCRIPT)
assert spec and spec.loader
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)

SHA = "a" * 40
OLD = "b" * 40
GEN = "c" * 32


class FakeObserver:
    def __init__(self, observations):
        self.values = list(observations)
        self.index = 0

    def observe(self):
        value = self.values[min(self.index, len(self.values) - 1)]
        self.index += 1
        return value


class RuntimeActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.prefix = base / "prefix"
        releases = self.prefix / "releases"
        releases.mkdir(parents=True)
        self.prefix.chmod(0o700)
        for sha in (SHA, OLD):
            release = releases / sha
            release.mkdir()
            receipt = release / ".installed.json"
            receipt.write_text(json.dumps({"commit": sha}) + "\n")
            receipt.chmod(0o644)
        (self.prefix / "current").symlink_to(Path("releases") / SHA)
        (self.prefix / "previous").symlink_to(Path("releases") / OLD)
        self.receipts = base / "receipts"
        self.receipts.mkdir(mode=0o700)
        self.config = runtime.Config(
            self.prefix,
            pwd.getpwuid(os.getuid()).pw_name,
            receipt_dir=self.receipts,
            timeout=0.2,
        )
        patcher = mock.patch.object(
            runtime,
            "_validate_root_dir",
            side_effect=lambda path, _mode: os.open(path, os.O_RDONLY | os.O_DIRECTORY),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def observation(self, main_pid, *, sha=SHA, generation=GEN, poller=True, renderer=True, control=True, extra=None):
        bun = str(self.config.service_home / ".bun/bin/bun")
        claude = str(self.config.service_home / ".local/bin/claude")
        argv: dict[int, tuple[str, ...]] = {main_pid: ("/usr/bin/script", "-qefc", "claude")}
        if poller:
            argv[main_pid + 1] = (claude, "--continue", "--channels", "plugin:telegram@claude-plugins-official")
        if renderer:
            argv[main_pid + 2] = (bun, "run", f"{self.prefix}/current/packages/telegram-renderer-mcp/src/server.ts")
        if control:
            argv[main_pid + 3] = (bun, "run", f"{self.prefix}/current/packages/session-control-mcp/src/server.ts")
        if extra:
            argv.update(extra)
        environment = {
            pid: {
                "CLAUDE_RUNTIME_RELEASE_SHA": sha,
                "CLAUDE_RUNTIME_GENERATION": generation,
            }
            for pid in argv if pid != main_pid
        }
        return runtime.Observation(
            main_pid,
            "active",
            "running",
            runtime.CONTROL_GROUP,
            tuple(sorted(argv)),
            argv,
            environment,
        )

    @staticmethod
    def run_recorder(calls, *, fail=False):
        def run(argv):
            calls.append(argv)
            if fail and argv[1] == "restart":
                raise RuntimeError("restart failed")
            return ""
        return run

    def activate(self, observations, calls=None, **kwargs):
        calls = [] if calls is None else calls
        return runtime.activate(
            self.config,
            SHA,
            observer=FakeObserver(observations),
            run=self.run_recorder(calls),
            generation=GEN,
            write_env=lambda sha, generation: self.assertEqual((sha, generation), (SHA, GEN)),
            **kwargs,
        )

    def test_release_authority_rejects_wrong_current_and_insecure_receipt(self):
        (self.prefix / "current").unlink()
        (self.prefix / "current").symlink_to(Path("releases") / OLD)
        with self.assertRaisesRegex(RuntimeError, "current release changed"):
            with runtime.ReleaseAuthority(self.config, SHA):
                pass
        (self.prefix / "current").unlink()
        (self.prefix / "current").symlink_to(Path("releases") / SHA)
        (self.prefix / "releases" / SHA / ".installed.json").chmod(0o600)
        with self.assertRaisesRegex(ValueError, "secure regular"):
            with runtime.ReleaseAuthority(self.config, SHA):
                pass

    def test_compatibility_checker_executes_pinned_root_asset_fd(self):
        checker = Path(self.temp.name) / "checker.py"
        checker.write_text("print('ok')\n")
        checker.chmod(0o755)
        actual = checker.stat()
        info = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o755,
            st_uid=0,
            st_nlink=1,
            st_size=actual.st_size,
            st_dev=actual.st_dev,
            st_ino=actual.st_ino,
        )
        config = runtime.Config(
            self.prefix,
            self.config.service_user,
            receipt_dir=self.receipts,
            settings=Path(self.temp.name) / "settings.json",
        )
        completed = runtime.subprocess.CompletedProcess([], 0, '{"compatible":true}', "")
        with mock.patch.object(runtime, "COMPATIBILITY_CHECK", checker), \
                mock.patch.object(Path, "lstat", return_value=info), \
                mock.patch.object(runtime.subprocess, "run", return_value=completed) as run:
            runtime._check_claude_compatibility(config)
        argv = run.call_args.args[0]
        self.assertTrue(argv[1].startswith("/proc/self/fd/"))
        self.assertEqual(run.call_args.kwargs["pass_fds"], (int(argv[1].split("/")[-1]),))

    def test_compatibility_failure_prevents_generation_write_and_restart(self):
        calls = []
        writes = []
        with mock.patch.object(
            runtime,
            "_check_claude_compatibility",
            side_effect=RuntimeError("incompatible"),
        ):
            with self.assertRaisesRegex(RuntimeError, "incompatible"):
                runtime.activate(
                    self.config,
                    SHA,
                    observer=FakeObserver([]),
                    run=self.run_recorder(calls),
                    generation=GEN,
                    write_env=lambda sha, generation: writes.append((sha, generation)),
                )
        self.assertEqual(calls, [])
        self.assertEqual(writes, [])
        self.assertEqual(list(self.receipts.iterdir()), [])


    def test_success_requires_new_exact_generation_and_two_stable_role_observations(self):
        calls = []
        result = self.activate(
            [self.observation(10, generation="0" * 32), self.observation(11), self.observation(11)],
            calls,
        )
        self.assertEqual(result["release_sha"], SHA)
        self.assertEqual(result["generation"], GEN)
        self.assertEqual(result["new_main_pid"], 11)
        self.assertEqual(calls, [[runtime.SYSTEMCTL, "restart", runtime.SERVICE]])
        payload = json.loads(Path(result["receipt"]).read_text())
        self.assertEqual(payload["release_sha"], SHA)
        self.assertEqual(set(payload["roles"]), {"poller", "renderer", "session_control"})

    def test_wrong_sha_or_generation_never_converges_and_does_not_publish(self):
        clock = iter((0.0, 0.1, 0.3, 0.4))
        with self.assertRaisesRegex(RuntimeError, "did not converge"):
            self.activate(
                [self.observation(10), self.observation(11, sha=OLD), self.observation(11, generation="0" * 32)],
                now=lambda: next(clock),
                sleep=lambda _seconds: None,
            )
        self.assertEqual(list(self.receipts.iterdir()), [])
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{SHA}")

    def test_missing_duplicate_and_wrong_argv_roles_are_rejected(self):
        with runtime.ReleaseAuthority(self.config, SHA) as authority:
            missing = self.observation(11, renderer=False)
            with self.assertRaisesRegex(RuntimeError, "renderer process count is 0"):
                runtime._check_observation(self.config, authority, SHA, GEN, missing, 10)
            duplicate = self.observation(11, extra={99: (str(self.config.service_home / ".local/bin/claude"), "--continue", "--channels", "plugin:telegram@claude-plugins-official")})
            duplicate.environment[99] = {
                "CLAUDE_RUNTIME_RELEASE_SHA": SHA,
                "CLAUDE_RUNTIME_GENERATION": GEN,
            }
            with self.assertRaisesRegex(RuntimeError, "poller process count is 2"):
                runtime._check_observation(self.config, authority, SHA, GEN, duplicate, 10)
            wrong = self.observation(11)
            wrong.argv[14] = (str(self.config.service_home / ".bun/bin/bun"), "run", "/tmp/control.ts")
            with self.assertRaisesRegex(RuntimeError, "session_control process count is 0"):
                runtime._check_observation(self.config, authority, SHA, GEN, wrong, 10)

    def test_transient_cgroup_processes_do_not_break_stability(self):
        first = self.observation(11, extra={90: ("/usr/bin/python3", "hook-one")})
        second = self.observation(11, extra={91: ("/usr/bin/python3", "hook-two")})
        result = self.activate([self.observation(10), first, second])
        self.assertEqual(result["new_main_pid"], 11)

    def test_restart_failure_does_not_mutate_current_or_publish(self):
        calls = []
        with self.assertRaisesRegex(RuntimeError, "restart failed"):
            runtime.activate(
                self.config,
                SHA,
                observer=FakeObserver([self.observation(10)]),
                run=self.run_recorder(calls, fail=True),
                generation=GEN,
                write_env=lambda _sha, _generation: None,
            )
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{SHA}")
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_current_change_during_restart_is_rejected_without_root_rollback(self):
        class ChangingObserver(FakeObserver):
            def observe(inner_self):
                value = super(ChangingObserver, inner_self).observe()
                if inner_self.index == 2:
                    (self.prefix / "current").unlink()
                    (self.prefix / "current").symlink_to(Path("releases") / OLD)
                return value
        with self.assertRaisesRegex(RuntimeError, "current release changed"):
            runtime.activate(
                self.config,
                SHA,
                observer=ChangingObserver([self.observation(10), self.observation(11)]),
                run=self.run_recorder([]),
                generation=GEN,
                write_env=lambda _sha, _generation: None,
            )
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{OLD}")
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_receipt_readback_failure_cleans_owned_leaf_and_collision_preserves_victim(self):
        payload = {"release_sha": SHA, "roles": {}}
        with mock.patch.object(runtime.time, "time_ns", return_value=1), mock.patch.object(runtime.secrets, "token_hex", return_value="fixed"):
            with mock.patch.object(runtime, "_read_json_at", side_effect=RuntimeError("readback failed")):
                with self.assertRaisesRegex(RuntimeError, "readback failed"):
                    runtime._publish(self.config, payload)
            self.assertEqual(list(self.receipts.iterdir()), [])
            victim = self.receipts / f"{SHA}-1-fixed.json"
            victim.write_text("victim")
            victim.chmod(0o600)
            with self.assertRaises(FileExistsError):
                runtime._publish(self.config, payload)
            self.assertEqual(victim.read_text(), "victim")

    def test_non_root_main_is_rejected(self):
        with mock.patch.object(runtime.os, "geteuid", return_value=1000):
            self.assertEqual(runtime.main([SHA]), 1)


class RootAuthorityDirectoryTests(unittest.TestCase):
    def test_anchored_directory_walk_rejects_writable_symlinked_and_wrong_owner_ancestors(self):
        with tempfile.TemporaryDirectory() as td:
            anchor = Path(td)
            anchor.chmod(0o700)
            parent = anchor / "authority"
            leaf = parent / "root"
            leaf.mkdir(parents=True)
            parent.chmod(0o755)
            leaf.chmod(0o700)
            fd = runtime._open_anchored_dir(anchor, leaf, 0o700, expected_uid=os.getuid(), expected_gid=os.getgid())
            os.close(fd)
            parent.chmod(0o777)
            with self.assertRaisesRegex(ValueError, "ancestor is writable"):
                runtime._open_anchored_dir(anchor, leaf, 0o700, expected_uid=os.getuid(), expected_gid=os.getgid())
            parent.chmod(0o755)
            leaf.rmdir()
            leaf.symlink_to(anchor)
            with self.assertRaises(OSError):
                runtime._open_anchored_dir(anchor, leaf, 0o700, expected_uid=os.getuid(), expected_gid=os.getgid())
            leaf.unlink()
            leaf.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, "anchor is not trusted"):
                runtime._open_anchored_dir(anchor, leaf, 0o700, expected_uid=999999, expected_gid=os.getgid())


if __name__ == "__main__":
    unittest.main()
