#!/usr/bin/env python3
"""Reset a Telegram-connected Claude Code service to a fresh session.

The executable accepts only a root-owned configuration file plus an optional
allowlisted Telegram chat ID. It never accepts executable paths or shell
commands from the caller.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pwd
import re
import shlex
import stat
import subprocess
import sys
import time
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

DEFAULT_CONFIG_PATH = Path("/etc/claude-code-telegram-kit/reset.json")
DEFAULT_FRESH_SEED = (
    "Initialize a fresh Claude Code channel session. "
    "Do not call tools or send messages. Reply only READY."
)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]{20,}$")
SERVICE_RE = re.compile(r"^[A-Za-z0-9_.@-]+\.service$")
_ALLOWED_CONFIG_FIELDS = {
    "service_name",
    "service_user",
    "workspace",
    "project_sessions",
    "channel_state",
    "lock_path",
    "poller_process_marker",
    "required_process_markers",
    "fresh_seed",
}
_REQUIRED_CONFIG_FIELDS = _ALLOWED_CONFIG_FIELDS - {"fresh_seed"}


@dataclass(frozen=True)
class ResetConfig:
    service_name: str
    service_user: str
    service_uid: int
    workspace: Path
    project_sessions: Path
    channel_state: Path
    lock_path: Path
    poller_process_marker: str
    required_process_markers: tuple[str, ...]
    fresh_seed: str = DEFAULT_FRESH_SEED

    @property
    def unit_path(self) -> Path:
        return Path("/etc/systemd/system") / self.service_name


def _validate_uuid(value: str) -> None:
    if not UUID_RE.fullmatch(value):
        raise ValueError("invalid session UUID")


def _secure_regular_file(path: Path, expected_uid: int, mode: int, label: str) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError(f"{label} must be a regular non-symlink file")
    if stat.S_IMODE(info.st_mode) != mode:
        raise ValueError(f"{label} must have mode {mode:04o}")
    if info.st_uid != expected_uid:
        raise ValueError(f"{label} has the wrong owner")
    if info.st_nlink != 1:
        raise ValueError(f"{label} must have one hardlink")
    return info


def _absolute_path(value: object, field: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{field} must be absolute")
    return path


def load_config(
    path: Path,
    *,
    expected_uid: int = 0,
    user_lookup: Callable[[str], int] | None = None,
) -> ResetConfig:
    _secure_regular_file(path, expected_uid, 0o644, "reset config")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("reset config must be a JSON object")
    unknown = set(raw) - _ALLOWED_CONFIG_FIELDS
    if unknown:
        raise ValueError("unknown config fields: " + ", ".join(sorted(unknown)))
    missing = _REQUIRED_CONFIG_FIELDS - set(raw)
    if missing:
        raise ValueError("missing config fields: " + ", ".join(sorted(missing)))

    service_name = raw["service_name"]
    service_user = raw["service_user"]
    if not isinstance(service_name, str) or not SERVICE_RE.fullmatch(service_name):
        raise ValueError("invalid service_name")
    if not isinstance(service_user, str) or not service_user:
        raise ValueError("invalid service_user")
    lookup = user_lookup or (lambda name: pwd.getpwnam(name).pw_uid)
    service_uid = lookup(service_user)

    lock_path = _absolute_path(raw["lock_path"], "lock_path")
    try:
        lock_path.relative_to("/run/lock")
    except ValueError as exc:
        raise ValueError("lock_path must be under /run/lock") from exc

    poller_marker = raw["poller_process_marker"]
    required_markers = raw["required_process_markers"]
    if not isinstance(poller_marker, str) or not poller_marker.strip():
        raise ValueError("poller_process_marker must be non-empty")
    if (
        not isinstance(required_markers, list)
        or not required_markers
        or not all(isinstance(item, str) and item.strip() for item in required_markers)
    ):
        raise ValueError("required_process_markers must be a non-empty string list")

    seed = raw.get("fresh_seed", DEFAULT_FRESH_SEED)
    if not isinstance(seed, str) or not seed.strip() or len(seed) > 500:
        raise ValueError("fresh_seed must be a non-empty string up to 500 characters")

    return ResetConfig(
        service_name=service_name,
        service_user=service_user,
        service_uid=service_uid,
        workspace=_absolute_path(raw["workspace"], "workspace"),
        project_sessions=_absolute_path(raw["project_sessions"], "project_sessions"),
        channel_state=_absolute_path(raw["channel_state"], "channel_state"),
        lock_path=lock_path,
        poller_process_marker=poller_marker,
        required_process_markers=tuple(required_markers),
        fresh_seed=seed,
    )


def _transform_continue_unit(unit: str, replacement: str, *, seed: str | None) -> str:
    if unit.count("--continue") != 1:
        raise ValueError("unit must contain exactly one --continue")
    transformed = unit.replace("--continue", replacement, 1)
    if seed is not None:
        marker = '" /dev/null'
        if transformed.count(marker) != 1:
            raise ValueError("unit must contain exactly one script output marker")
        transformed = transformed.replace(marker, f" {shlex.quote(seed)}\" /dev/null", 1)
    return transformed


def fresh_unit_from_continue(unit: str, session_id: str, seed: str = DEFAULT_FRESH_SEED) -> str:
    _validate_uuid(session_id)
    return _transform_continue_unit(unit, f"--session-id {session_id}", seed=seed)


def resume_unit_from_continue(unit: str, session_id: str) -> str:
    _validate_uuid(session_id)
    return _transform_continue_unit(unit, f"--resume {session_id}", seed=None)


def validate_notification_target(state_dir: Path, chat_id: str, *, expected_uid: int) -> str:
    if not re.fullmatch(r"\d+", chat_id):
        raise ValueError("invalid chat ID")
    root = state_dir.lstat()
    if stat.S_ISLNK(root.st_mode) or not stat.S_ISDIR(root.st_mode):
        raise ValueError("channel state root must be a real directory")
    if stat.S_IMODE(root.st_mode) != 0o700 or root.st_uid != expected_uid:
        raise ValueError("channel state root must be owned by the service user with mode 0700")

    env_path = state_dir / ".env"
    access_path = state_dir / "access.json"
    _secure_regular_file(env_path, expected_uid, 0o600, "channel state")
    _secure_regular_file(access_path, expected_uid, 0o600, "channel state")

    token_lines = [
        line.split("=", 1)[1].strip()
        for line in env_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("TELEGRAM_BOT_TOKEN=")
    ]
    if len(token_lines) != 1 or not TOKEN_RE.fullmatch(token_lines[0]):
        raise ValueError("invalid Telegram bot token state")

    access = json.loads(access_path.read_text(encoding="utf-8"))
    if access.get("dmPolicy") != "allowlist":
        raise ValueError("dmPolicy must be allowlist")
    allowed = access.get("allowFrom")
    if not isinstance(allowed, list) or not all(isinstance(value, str) for value in allowed):
        raise ValueError("invalid Telegram allowlist")
    if chat_id not in allowed:
        raise ValueError("chat is not authorized")
    return token_lines[0]


def _assistant_text(message: dict[str, Any]) -> list[str]:
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [
        item["text"]
        for item in content
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
    ]


def transcript_has_ready(path: Path, session_id: str) -> bool:
    if not path.is_file():
        return False
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                record_session = record.get("sessionId") or record.get("session_id")
                if record_session != session_id:
                    continue
                message = record.get("message")
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                if any(text.strip() == "READY" for text in _assistant_text(message)):
                    return True
    except OSError:
        return False
    return False


def _run(argv: list[str], *, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=True)


def _atomic_write(path: Path, content: str, mode: int = 0o644) -> None:
    parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temp_name = f".{path.name}.tmp.{uuid.uuid4().hex}"
    fd: int | None = None
    try:
        fd = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
            dir_fd=parent_fd,
        )
        data = content.encode("utf-8")
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if written <= 0:
                raise OSError("short unit write")
            offset += written
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temp_name, path.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def _read_canonical_unit(config: ResetConfig) -> str:
    _secure_regular_file(config.unit_path, 0, 0o644, "service unit")
    unit = config.unit_path.read_text(encoding="utf-8")
    if unit.count("--continue") != 1:
        raise RuntimeError("service unit is not in steady --continue state")
    return unit


def _latest_session_id(config: ResetConfig) -> str:
    candidates = [p for p in config.project_sessions.glob("*.jsonl") if UUID_RE.fullmatch(p.stem)]
    if not candidates:
        raise RuntimeError("no previous Claude Code session exists")
    return max(candidates, key=lambda p: p.stat().st_mtime).stem


def _process_rows() -> dict[int, tuple[int, str]]:
    rows: dict[int, tuple[int, str]] = {}
    for child in Path("/proc").iterdir():
        if not child.name.isdigit():
            continue
        try:
            fields = (child / "stat").read_text().split()
            parent = int(fields[3])
            command = (child / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            rows[int(child.name)] = (parent, command)
        except (OSError, ValueError, IndexError):
            continue
    return rows


def _service_health(config: ResetConfig, expected_session_id: str) -> bool:
    try:
        _run(["systemctl", "is-active", "--quiet", config.service_name], timeout=10)
        main = int(_run(
            ["systemctl", "show", "-p", "MainPID", "--value", config.service_name],
            timeout=10,
        ).stdout.strip())
    except Exception:
        return False
    rows = _process_rows()
    descendants: list[str] = []
    frontier = [main]
    seen = {main}
    while frontier:
        parent = frontier.pop()
        for pid, (ppid, command) in rows.items():
            if ppid == parent and pid not in seen:
                seen.add(pid)
                frontier.append(pid)
                descendants.append(command)
    claude_ok = any(f"--session-id {expected_session_id}" in command for command in descendants)
    poller_ok = any(config.poller_process_marker in command for command in descendants)
    required_ok = all(any(marker in command for command in descendants) for marker in config.required_process_markers)
    return claude_ok and poller_ok and required_ok


def _wait_for_fresh_session(config: ResetConfig, session_id: str, timeout: float) -> None:
    transcript = config.project_sessions / f"{session_id}.jsonl"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if transcript_has_ready(transcript, session_id) and _service_health(config, session_id):
            return
        time.sleep(1)
    raise TimeoutError("fresh Claude Code session did not become ready")


def _wait_active(config: ResetConfig, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            _run(["systemctl", "is-active", "--quiet", config.service_name], timeout=5)
            return
        except Exception:
            time.sleep(1)
    raise TimeoutError("Claude Code service did not become active")


def _reload_and_restart(config: ResetConfig) -> None:
    _run(["systemctl", "daemon-reload"], timeout=20)
    _run(["systemctl", "restart", config.service_name], timeout=30)


def _reload_only() -> None:
    _run(["systemctl", "daemon-reload"], timeout=20)


def _notify(token: str, chat_id: str, text: str) -> int:
    payload = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.loads(response.read().decode("utf-8"))
    message_id = result.get("result", {}).get("message_id")
    if result.get("ok") is not True or not isinstance(message_id, int):
        raise RuntimeError("Telegram notification failed")
    return message_id


def _recover_old(config: ResetConfig, original_unit: str, old_session: str) -> bool:
    try:
        _atomic_write(config.unit_path, resume_unit_from_continue(original_unit, old_session))
        _reload_and_restart(config)
        _wait_active(config)
        _atomic_write(config.unit_path, original_unit)
        _reload_only()
        return True
    except Exception:
        try:
            _atomic_write(config.unit_path, original_unit)
            _reload_only()
        except Exception:
            pass
        return False


def reset_session(config: ResetConfig, *, chat_id: str | None, timeout: float) -> dict[str, Any]:
    if os.geteuid() != 0:
        raise PermissionError("session reset helper must run as root")
    token: str | None = None
    if chat_id is not None:
        token = validate_notification_target(config.channel_state, chat_id, expected_uid=config.service_uid)

    config.lock_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    lock_fd = os.open(config.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another session reset is already running") from exc

        original_unit = _read_canonical_unit(config)
        old_session = _latest_session_id(config)
        new_session = str(uuid.uuid4())
        try:
            _atomic_write(
                config.unit_path,
                fresh_unit_from_continue(original_unit, new_session, config.fresh_seed),
            )
            _reload_and_restart(config)
            _wait_for_fresh_session(config, new_session, timeout)
            _atomic_write(config.unit_path, original_unit)
            _reload_only()
            if not _service_health(config, new_session):
                raise RuntimeError("post-restore health check failed")
        except Exception as exc:
            recovered = _recover_old(config, original_unit, old_session)
            if token is not None and chat_id is not None:
                status = "previous session restored" if recovered else "manual recovery required"
                try:
                    _notify(token, chat_id, f"Session reset failed; {status}.")
                except Exception:
                    pass
            raise RuntimeError("session reset failed") from exc

        completion_id: int | None = None
        if token is not None and chat_id is not None:
            completion_id = _notify(
                token,
                chat_id,
                f"Session reset complete. New session: {new_session[:8]}…",
            )
        return {
            "status": "reset_complete",
            "old_session": old_session,
            "new_session": new_session,
            "completion_message_id": completion_id,
        }
    finally:
        os.close(lock_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reset a Telegram-connected Claude Code session")
    parser.add_argument(
        "--config",
        default=os.environ.get("CLAUDE_SESSION_RESET_CONFIG", str(DEFAULT_CONFIG_PATH)),
    )
    parser.add_argument("--chat-id")
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args(argv)
    try:
        config = load_config(Path(args.config))
        result = reset_session(config, chat_id=args.chat_id, timeout=args.timeout)
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
