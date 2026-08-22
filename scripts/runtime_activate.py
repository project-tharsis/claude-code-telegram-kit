#!/usr/bin/env python3
"""Root-only exact-SHA activation for the fixed Claude Telegram runtime."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import pwd
import secrets
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

SHA_LEN = 40
SYSTEMCTL = "/usr/bin/systemctl"
SERVICE = "claude-telegram.service"
CONTROL_GROUP = "/system.slice/claude-telegram.service"
CGROUP_ROOT = Path("/sys/fs/cgroup")
ROOT_LOCK = Path("/run/lock/claude-code-telegram-kit/root/runtime-activate.lock")
SHARED_LOCK = Path("/run/lock/claude-code-telegram-kit/shared/deploy-activation.lock")
ACTIVATION_ENV = Path("/run/claude-code-telegram-activation/activation.env")
RECEIPT_DIR = Path("/var/lib/claude-code-telegram-kit/activation")
MAX_JSON_BYTES = 64 * 1024


class RuntimeNotReady(RuntimeError):
    """The fixed runtime has not yet converged; retrying within the deadline is safe."""


def exact_sha(value: str) -> str:
    if len(value) != SHA_LEN or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("activation requires an exact 40-character lowercase SHA")
    return value


@dataclass(frozen=True)
class Config:
    prefix: Path
    service_user: str
    service: str = SERVICE
    receipt_dir: Path = RECEIPT_DIR
    timeout: float = 60.0

    @property
    def account(self) -> pwd.struct_passwd:
        return pwd.getpwnam(self.service_user)

    @property
    def service_uid(self) -> int:
        return self.account.pw_uid

    @property
    def service_gid(self) -> int:
        return self.account.pw_gid

    @property
    def service_home(self) -> Path:
        return Path(self.account.pw_dir)

    @classmethod
    def load(cls, path: Path, *, expected_uid: int = 0) -> "Config":
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
                or info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1):
            raise ValueError("activation config is not a secure root-owned file")
        data = json.loads(path.read_text(encoding="utf-8"))
        allowed = {"prefix", "service_user", "service", "receipt_dir", "timeout"}
        if not isinstance(data, dict) or set(data) - allowed or not {"prefix", "service_user"} <= set(data):
            raise ValueError("activation config is incomplete or has unknown fields")
        prefix = data["prefix"]
        user = data["service_user"]
        if not isinstance(prefix, str) or not Path(prefix).is_absolute() or ".." in Path(prefix).parts:
            raise ValueError("activation prefix must be an absolute non-traversing path")
        if not isinstance(user, str) or not user or "/" in user or any(c.isspace() for c in user):
            raise ValueError("activation service_user is invalid")
        service = data.get("service", SERVICE)
        if service != SERVICE:
            raise ValueError("activation service is fixed")
        receipt = data.get("receipt_dir", str(RECEIPT_DIR))
        if receipt != str(RECEIPT_DIR):
            raise ValueError("activation receipt_dir is fixed")
        timeout = float(data.get("timeout", 60.0))
        if not 0 < timeout <= 300:
            raise ValueError("activation timeout is out of bounds")
        account = pwd.getpwnam(user)
        if account.pw_uid == 0:
            raise ValueError("activation service_user must be unprivileged")
        return cls(Path(prefix), user, service, RECEIPT_DIR, timeout)


def _validate_directory(info: os.stat_result, uid: int, mode: int, label: str) -> None:
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode):
        raise ValueError(f"{label} is not a real {uid}-owned mode-{mode:04o} directory")


def _read_fd(fd: int, limit: int = MAX_JSON_BYTES) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(fd, min(8192, limit + 1 - total))
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise ValueError("JSON authority exceeds bounded size")


def _read_json_at(dir_fd: int, name: str, expected_uid: int, mode: int) -> dict[str, Any]:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid
                or stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1):
            raise ValueError("release receipt is not a secure regular file")
        value = json.loads(_read_fd(fd).decode("utf-8"))
    finally:
        os.close(fd)
    if not isinstance(value, dict):
        raise ValueError("release receipt is not an object")
    return value


class ReleaseAuthority:
    def __init__(self, config: Config, expected_sha: str):
        self.config = config
        self.expected_sha = exact_sha(expected_sha)
        self.prefix_fd = -1
        self.releases_fd = -1
        self.release_fd = -1
        self.prefix_identity: tuple[int, int] | None = None
        self.release_identity: tuple[int, int] | None = None

    def __enter__(self) -> "ReleaseAuthority":
        before = self.config.prefix.lstat()
        _validate_directory(before, self.config.service_uid, 0o700, "activation prefix")
        self.prefix_fd = os.open(self.config.prefix, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened = os.fstat(self.prefix_fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("activation prefix changed during validation")
        self.prefix_identity = (opened.st_dev, opened.st_ino)
        self.releases_fd = os.open("releases", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.prefix_fd)
        releases = os.fstat(self.releases_fd)
        if releases.st_uid != self.config.service_uid or (releases.st_mode & 0o022) != 0:
            raise ValueError("releases directory is not secure")
        self.release_fd = os.open(self.expected_sha, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.releases_fd)
        release = os.fstat(self.release_fd)
        if release.st_uid != self.config.service_uid or (release.st_mode & 0o022) != 0:
            raise ValueError("release directory is not secure")
        self.release_identity = (release.st_dev, release.st_ino)
        self.revalidate()
        return self

    def __exit__(self, *_args: object) -> None:
        for fd in (self.release_fd, self.releases_fd, self.prefix_fd):
            if fd >= 0:
                os.close(fd)

    def revalidate(self) -> None:
        if self.prefix_fd < 0 or self.release_fd < 0 or self.prefix_identity is None or self.release_identity is None:
            raise RuntimeError("release authority is not open")
        live_prefix = self.config.prefix.lstat()
        opened_prefix = os.fstat(self.prefix_fd)
        if ((live_prefix.st_dev, live_prefix.st_ino) != self.prefix_identity
                or (opened_prefix.st_dev, opened_prefix.st_ino) != self.prefix_identity):
            raise RuntimeError("activation prefix identity changed")
        current_info = os.stat("current", dir_fd=self.prefix_fd, follow_symlinks=False)
        if not stat.S_ISLNK(current_info.st_mode) or current_info.st_uid != self.config.service_uid:
            raise RuntimeError("current is not a service-user-owned symlink")
        target = os.readlink("current", dir_fd=self.prefix_fd)
        expected_targets = {
            f"releases/{self.expected_sha}",
            str(self.config.prefix / "releases" / self.expected_sha),
        }
        if target not in expected_targets:
            raise RuntimeError("current release changed during activation")
        release = os.fstat(self.release_fd)
        if (release.st_dev, release.st_ino) != self.release_identity:
            raise RuntimeError("release directory identity changed")
        receipt = _read_json_at(self.release_fd, ".installed.json", self.config.service_uid, 0o644)
        if receipt.get("commit") != self.expected_sha:
            raise RuntimeError("installed receipt does not match requested SHA")


@dataclass(frozen=True)
class Observation:
    main_pid: int
    active_state: str
    sub_state: str
    control_group: str
    cgroup_pids: tuple[int, ...]
    argv: Mapping[int, tuple[str, ...]]
    environment: Mapping[int, Mapping[str, str]]


class Observer(Protocol):
    def observe(self) -> Observation: ...


def _run_systemctl(argv: list[str]) -> str:
    if not argv or argv[0] != SYSTEMCTL:
        raise ValueError("systemctl path is not fixed")
    result = subprocess.run(argv, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode != 0:
        raise RuntimeError("systemctl failed")
    return result.stdout


def _read_proc(path: Path) -> bytes:
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_JSON_BYTES + 1)
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return b""
    return data if len(data) <= MAX_JSON_BYTES else b""


class SystemdCgroupObserver:
    def __init__(self, config: Config, run: Callable[[list[str]], str] = _run_systemctl):
        self.config = config
        self.run = run

    def observe(self) -> Observation:
        raw = self.run([SYSTEMCTL, "show", self.config.service, "--property=MainPID,ActiveState,SubState,ControlGroup"])
        fields: dict[str, str] = {}
        for line in raw.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                fields[key] = value
        try:
            main_pid = int(fields["MainPID"])
            control_group = fields["ControlGroup"]
        except (KeyError, ValueError) as exc:
            raise RuntimeError("systemd did not provide runtime generation") from exc
        if main_pid <= 0 or control_group != CONTROL_GROUP:
            raise RuntimeError("service has no fixed MainPID/cgroup")
        cgroup = CGROUP_ROOT / control_group.lstrip("/")
        pids = tuple(sorted(int(line) for line in cgroup.joinpath("cgroup.procs").read_text().split()))
        argv: dict[int, tuple[str, ...]] = {}
        environment: dict[int, dict[str, str]] = {}
        for pid in pids:
            cmdline = _read_proc(Path(f"/proc/{pid}/cmdline"))
            if not cmdline:
                continue
            argv[pid] = tuple(os.fsdecode(part) for part in cmdline.split(b"\0") if part)
            values: dict[str, str] = {}
            for item in _read_proc(Path(f"/proc/{pid}/environ")).split(b"\0"):
                if b"=" not in item:
                    continue
                key, value = item.split(b"=", 1)
                decoded = os.fsdecode(key)
                if decoded in {"CLAUDE_RUNTIME_RELEASE_SHA", "CLAUDE_RUNTIME_GENERATION"}:
                    values[decoded] = os.fsdecode(value)
            environment[pid] = values
        return Observation(main_pid, fields.get("ActiveState", ""), fields.get("SubState", ""), control_group, pids, argv, environment)


def _expected_roles(config: Config) -> dict[str, Callable[[tuple[str, ...]], bool]]:
    bun = str(config.service_home / ".bun/bin/bun")
    claude = str(config.service_home / ".local/bin/claude")
    current = str(config.prefix / "current")

    def poller(argv: tuple[str, ...]) -> bool:
        if not argv or argv[0] != claude:
            return False
        try:
            index = argv.index("--channels")
        except ValueError:
            return False
        return index + 1 < len(argv) and argv[index + 1] == "plugin:telegram@claude-plugins-official"

    return {
        "poller": poller,
        "renderer": lambda argv: argv == (bun, "run", f"{current}/packages/telegram-renderer-mcp/src/server.ts"),
        "session_control": lambda argv: argv == (bun, "run", f"{current}/packages/session-control-mcp/src/server.ts"),
    }


def _check_observation(
    config: Config,
    authority: ReleaseAuthority,
    expected_sha: str,
    generation: str,
    observation: Observation,
    old_pid: int,
) -> dict[str, int]:
    authority.revalidate()
    if observation.active_state != "active" or observation.sub_state != "running":
        raise RuntimeNotReady("service is not active/running")
    if observation.control_group != CONTROL_GROUP or observation.main_pid == old_pid:
        raise RuntimeNotReady("service did not obtain a new fixed generation")
    if observation.main_pid not in observation.cgroup_pids:
        raise RuntimeNotReady("MainPID is not in the service cgroup")
    result: dict[str, int] = {}
    for role, predicate in _expected_roles(config).items():
        matches = [pid for pid in observation.cgroup_pids if pid != observation.main_pid and predicate(observation.argv.get(pid, ()))]
        if len(matches) != 1:
            raise RuntimeNotReady(f"{role} process count is {len(matches)}, expected exactly one")
        pid = matches[0]
        env = observation.environment.get(pid, {})
        if env.get("CLAUDE_RUNTIME_RELEASE_SHA") != expected_sha or env.get("CLAUDE_RUNTIME_GENERATION") != generation:
            raise RuntimeNotReady(f"{role} process lacks exact activation generation")
        result[role] = pid
    return result


def _open_anchored_dir(
    anchor: Path,
    target: Path,
    mode: int,
    *,
    expected_uid: int = 0,
    expected_gid: int = 0,
) -> int:
    try:
        parts = target.relative_to(anchor).parts
    except ValueError as exc:
        raise ValueError("runtime authority directory is outside its fixed anchor") from exc
    if not parts:
        raise ValueError("runtime authority directory must be below its fixed anchor")
    fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root = os.fstat(fd)
        if not stat.S_ISDIR(root.st_mode) or root.st_uid != expected_uid:
            raise ValueError("runtime authority anchor is not trusted")
        for index, part in enumerate(parts):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid:
                raise ValueError("runtime authority ancestor is not root-owned")
            if index == len(parts) - 1:
                if stat.S_IMODE(info.st_mode) != mode or info.st_gid != expected_gid:
                    raise ValueError("root directory ownership or mode is invalid")
            elif (info.st_mode & 0o022) != 0:
                raise ValueError("runtime authority ancestor is writable")
        return fd
    except Exception:
        os.close(fd)
        raise


def _validate_root_dir(path: Path, mode: int, expected_gid: int = 0) -> int:
    authorities = {
        ROOT_LOCK.parent: Path("/run/lock"),
        SHARED_LOCK.parent: Path("/run/lock"),
        ACTIVATION_ENV.parent: Path("/run"),
        RECEIPT_DIR: Path("/var/lib"),
    }
    anchor = authorities.get(path)
    if anchor is None:
        raise ValueError("runtime authority path is not fixed")
    return _open_anchored_dir(anchor, path, mode, expected_uid=0, expected_gid=expected_gid)


def _write_atomic_at(dir_fd: int, final_name: str, data: bytes, mode: int) -> None:
    temp = f".{final_name}.tmp.{secrets.token_hex(16)}"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=dir_fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fchmod(fd, mode)
        os.fsync(fd)
        os.replace(temp, final_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        os.fsync(dir_fd)
    except Exception:
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(fd)


def _write_exclusive_at(dir_fd: int, name: str, data: bytes, mode: int) -> tuple[int, int]:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=dir_fd)
    created = True
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
        os.fchmod(fd, mode)
        os.fsync(fd)
        info = os.fstat(fd)
        os.fsync(dir_fd)
        return info.st_dev, info.st_ino
    except Exception:
        if created:
            try:
                os.unlink(name, dir_fd=dir_fd)
                os.fsync(dir_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(fd)


def _unlink_if_identity(dir_fd: int, name: str, identity: tuple[int, int]) -> None:
    try:
        info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (info.st_dev, info.st_ino) != identity:
        raise RuntimeError("activation receipt identity changed before cleanup")
    os.unlink(name, dir_fd=dir_fd)
    os.fsync(dir_fd)


def _write_generation_env(sha: str, generation: str) -> None:
    directory = ACTIVATION_ENV.parent
    dir_fd = _validate_root_dir(directory, 0o700)
    try:
        body = (
            f"CLAUDE_RUNTIME_RELEASE_SHA={exact_sha(sha)}\n"
            f"CLAUDE_RUNTIME_GENERATION={generation}\n"
        ).encode("ascii")
        _write_atomic_at(dir_fd, ACTIVATION_ENV.name, body, 0o600)
    finally:
        os.close(dir_fd)


def _publish(config: Config, payload: dict[str, Any]) -> Path:
    dir_fd = _validate_root_dir(config.receipt_dir, 0o700)
    name = f"{payload['release_sha']}-{time.time_ns()}-{secrets.token_hex(8)}.json"
    data = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    identity: tuple[int, int] | None = None
    try:
        identity = _write_exclusive_at(dir_fd, name, data, 0o600)
        final = config.receipt_dir / name
        receipt = _read_json_at(dir_fd, name, os.geteuid(), 0o600)
        if receipt != payload:
            raise RuntimeError("activation receipt readback mismatch")
        return final
    except Exception:
        if identity is not None:
            _unlink_if_identity(dir_fd, name, identity)
        raise
    finally:
        os.close(dir_fd)


def _open_root_lock(path: Path, service_gid: int | None = None) -> int:
    parent_mode = 0o750 if service_gid is not None else 0o700
    expected_gid = service_gid if service_gid is not None else 0
    parent_fd = _validate_root_dir(path.parent, parent_mode, expected_gid)
    try:
        fd = os.open(path.name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            info = os.fstat(fd)
            expected_mode = 0o660 if service_gid is not None else 0o600
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or stat.S_IMODE(info.st_mode) != expected_mode or info.st_nlink != 1
                    or info.st_gid != expected_gid):
                raise ValueError("activation lock authority is invalid")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("deployment or activation is already active") from exc
            return fd
        except Exception:
            os.close(fd)
            raise
    finally:
        os.close(parent_fd)


def activate(
    config: Config,
    sha: str,
    *,
    observer: Observer | None = None,
    run: Callable[[list[str]], str] = _run_systemctl,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    generation: str | None = None,
    write_env: Callable[[str, str], None] = _write_generation_env,
) -> dict[str, Any]:
    sha = exact_sha(sha)
    generation = generation or secrets.token_hex(16)
    if len(generation) != 32 or any(char not in "0123456789abcdef" for char in generation):
        raise ValueError("activation generation is invalid")
    with ReleaseAuthority(config, sha) as authority:
        write_env(sha, generation)
        obs = observer or SystemdCgroupObserver(config, run)
        before = obs.observe()
        run([SYSTEMCTL, "restart", config.service])
        deadline = now() + config.timeout
        stable_key: tuple[int, tuple[tuple[str, int], ...]] | None = None
        while now() < deadline:
            candidate = obs.observe()
            try:
                roles = _check_observation(config, authority, sha, generation, candidate, before.main_pid)
            except RuntimeNotReady:
                sleep(0.05)
                continue
            key = (candidate.main_pid, tuple(sorted(roles.items())))
            if stable_key == key:
                payload = {
                    "version": 3,
                    "service": config.service,
                    "release_sha": sha,
                    "generation": generation,
                    "old_main_pid": before.main_pid,
                    "new_main_pid": candidate.main_pid,
                    "roles": roles,
                }
                receipt = _publish(config, payload)
                return {"status": "activated", "release_sha": sha, "generation": generation, "old_main_pid": before.main_pid, "new_main_pid": candidate.main_pid, "receipt": str(receipt)}
            stable_key = key
            sleep(0.05)
        raise RuntimeError("runtime did not converge for two stable exact-SHA observations")


def main(argv: list[str] | None = None) -> int:
    if os.geteuid() != 0:
        print(json.dumps({"status": "failed", "error": "runtime activation requires root"}), file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha")
    parser.add_argument("--config", default="/etc/claude-code-telegram-kit/activation.json")
    args = parser.parse_args(argv)
    root_fd = -1
    shared_fd = -1
    try:
        config = Config.load(Path(args.config))
        root_fd = _open_root_lock(ROOT_LOCK)
        shared_fd = _open_root_lock(SHARED_LOCK, config.service_gid)
        result = activate(config, args.sha)
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 1
    finally:
        if shared_fd >= 0:
            os.close(shared_fd)
        if root_fd >= 0:
            os.close(root_fd)
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
