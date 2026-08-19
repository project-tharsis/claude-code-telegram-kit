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
# Wire protocol between the unprivileged control MCP and this root helper. The MCP refuses to
# schedule anything until --capabilities reports exactly this protocol and these actions.
PROTOCOL_VERSION = 3
SUPPORTED_ACTIONS = ("reset", "resume")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]{20,}$")
REQUEST_ID_RE = re.compile(r"^[a-f0-9]{24}$")
REQUEST_STATE_ROOT = Path("/var/lib/claude-code-telegram-kit/reset-requests")
MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024
SERVICE_RE = re.compile(r"^[A-Za-z0-9_.@-]+\.service$")
# Receipt schema written by the SessionStart command-hook writer and read back by this helper.
RECEIPT_VERSION = 1
MAX_RECEIPT_BYTES = 64 * 1024
# Claude Code 2.1.235 starts Channel polling only after initial input. /agents is a
# non-modal local command: it initializes Channel plumbing, returns to the prompt, calls no
# LLM, and its local-command records are ignored by native ai-title generation. This avoids
# both the old synthetic READY prompt and /status's blocking Settings modal.
LOCAL_CHANNEL_BOOTSTRAP_COMMAND = "/agents"


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_ALLOWED_CONFIG_FIELDS = {
    "service_name",
    "service_user",
    "workspace",
    "project_sessions",
    "session_start_receipt_dir",
    "channel_state",
    "lock_path",
    "poller_process_marker",
    "required_process_markers",
    "allow_multiple_chats",
}
_REQUIRED_CONFIG_FIELDS = _ALLOWED_CONFIG_FIELDS - {"allow_multiple_chats"}


@dataclass(frozen=True)
class ResetConfig:
    service_name: str
    service_user: str
    service_uid: int
    workspace: Path
    project_sessions: Path
    session_start_receipt_dir: Path
    channel_state: Path
    lock_path: Path
    poller_process_marker: str
    required_process_markers: tuple[str, ...]
    allow_multiple_chats: bool = False

    @property
    def unit_path(self) -> Path:
        return Path("/etc/systemd/system") / self.service_name


def capabilities() -> dict[str, Any]:
    """Read-only capability report. Mutates nothing and needs neither root nor a config."""
    return {
        "protocol": PROTOCOL_VERSION,
        "actions": list(SUPPORTED_ACTIONS),
        "helper": "claude-code-session-reset",
    }


def _validate_uuid(value: str) -> None:
    if not UUID_RE.fullmatch(value):
        raise ValueError("invalid session UUID")


def _validate_file_info(
    info: os.stat_result,
    expected_uid: int,
    mode: int | tuple[int, ...],
    label: str,
) -> None:
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"{label} must be a regular file")
    modes = mode if isinstance(mode, tuple) else (mode,)
    if stat.S_IMODE(info.st_mode) not in modes:
        expected = " or ".join(f"{value:04o}" for value in modes)
        raise ValueError(f"{label} must have mode {expected}")
    if info.st_uid != expected_uid:
        raise ValueError(f"{label} has the wrong owner")
    if info.st_nlink != 1:
        raise ValueError(f"{label} must have one hardlink")


def _secure_regular_file(
    path: Path,
    expected_uid: int,
    mode: int | tuple[int, ...],
    label: str,
) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"{label} must be a regular non-symlink file")
    _validate_file_info(info, expected_uid, mode, label)
    return info


def _read_fd_text(fd: int, max_bytes: int, label: str) -> str:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = os.read(fd, min(64 * 1024, max_bytes + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > max_bytes:
            raise ValueError(f"{label} is too large")
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8")


def _read_secure_regular(
    path: Path,
    expected_uid: int,
    mode: int | tuple[int, ...],
    label: str,
    *,
    max_bytes: int = 256 * 1024,
) -> str:
    before = _secure_regular_file(path, expected_uid, mode, label)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        _validate_file_info(opened, expected_uid, mode, label)
        if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
            raise ValueError(f"{label} changed during validation")
        return _read_fd_text(fd, max_bytes, label)
    finally:
        os.close(fd)


def _read_secure_at(
    dir_fd: int,
    name: str,
    expected_uid: int,
    mode: int,
    label: str,
    *,
    max_bytes: int = 64 * 1024,
) -> str:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    try:
        _validate_file_info(os.fstat(fd), expected_uid, mode, label)
        return _read_fd_text(fd, max_bytes, label)
    finally:
        os.close(fd)


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def claim_request(
    state_root: Path,
    request_id: str,
    chat_id: str,
    *,
    action: str = "reset",
    target_session: str | None = None,
    expected_uid: int = 0,
) -> dict[str, Any]:
    if action not in SUPPORTED_ACTIONS:
        raise ValueError("invalid reset action")
    if action == "resume":
        if not isinstance(target_session, str):
            raise ValueError("resume claim requires a target session")
        _validate_uuid(target_session)
    elif target_session is not None:
        raise ValueError("reset claim must not carry a target session")
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("invalid reset request ID")
    if not re.fullmatch(r"\d+", chat_id):
        raise ValueError("invalid chat ID")
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root_info = state_root.lstat()
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise ValueError("reset request state must be a real directory")
    if stat.S_IMODE(root_info.st_mode) != 0o700 or root_info.st_uid != expected_uid:
        raise ValueError("reset request state must be private and correctly owned")

    receipt_path = state_root / f"{request_id}.json"
    payload = {
        "request_id": request_id,
        "chat_id": chat_id,
        "action": action,
        "target_session": target_session,
        "status": "in_progress",
        "updated_at": int(time.time()),
    }
    try:
        fd = os.open(
            receipt_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
    except FileExistsError:
        receipt = json.loads(_read_secure_regular(receipt_path, expected_uid, 0o600, "reset request receipt"))
        if (
            not isinstance(receipt, dict)
            or receipt.get("request_id") != request_id
            or receipt.get("chat_id") != chat_id
            or receipt.get("action") != action
            or receipt.get("target_session") != target_session
        ):
            raise ValueError("reset request receipt does not match request")
        return {"claimed": False, "receipt": receipt}

    try:
        data = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    _fsync_dir(state_root)
    return {"claimed": True, "receipt": payload}


def finish_request(
    state_root: Path,
    request_id: str,
    status_value: str,
    details: dict[str, Any],
    *,
    expected_uid: int = 0,
) -> dict[str, Any]:
    if status_value not in {"complete", "failed"}:
        raise ValueError("invalid reset request status")
    receipt_path = state_root / f"{request_id}.json"
    existing = json.loads(_read_secure_regular(receipt_path, expected_uid, 0o600, "reset request receipt"))
    if not isinstance(existing, dict) or existing.get("request_id") != request_id:
        raise ValueError("invalid reset request receipt")
    payload = {
        **existing,
        **details,
        "status": status_value,
        "updated_at": int(time.time()),
    }
    temp = state_root / f".{request_id}.tmp.{uuid.uuid4().hex}"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, receipt_path)
    _fsync_dir(state_root)
    return payload


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
    raw = json.loads(_read_secure_regular(path, expected_uid, (0o600, 0o644), "reset config"))
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

    allow_multiple_chats = raw.get("allow_multiple_chats", False)
    if not isinstance(allow_multiple_chats, bool):
        raise ValueError("allow_multiple_chats must be boolean")

    return ResetConfig(
        service_name=service_name,
        service_user=service_user,
        service_uid=service_uid,
        workspace=_absolute_path(raw["workspace"], "workspace"),
        project_sessions=_absolute_path(raw["project_sessions"], "project_sessions"),
        session_start_receipt_dir=_absolute_path(raw["session_start_receipt_dir"], "session_start_receipt_dir"),
        channel_state=_absolute_path(raw["channel_state"], "channel_state"),
        lock_path=lock_path,
        poller_process_marker=poller_marker,
        required_process_markers=tuple(required_markers),
        allow_multiple_chats=allow_multiple_chats,
    )


def _transform_continue_unit(unit: str, replacement: str) -> str:
    if unit.count("--continue") != 1:
        raise ValueError("unit must contain exactly one --continue")
    return unit.replace("--continue", replacement, 1)


def fresh_unit_from_continue(unit: str, session_id: str) -> str:
    _validate_uuid(session_id)
    # The fresh unit pins the exact new session. /agents is a Claude-local command, not an
    # LLM prompt; the SessionStart command hook reports readiness through a receipt.
    transformed = _transform_continue_unit(unit, f"--session-id {session_id}")
    marker = '" /dev/null'
    if transformed.count(marker) != 1:
        raise ValueError("unit must contain exactly one script output marker")
    return transformed.replace(
        marker,
        f" {shlex.quote(LOCAL_CHANNEL_BOOTSTRAP_COMMAND)}\" /dev/null",
        1,
    )


def resume_unit_from_continue(unit: str, session_id: str) -> str:
    _validate_uuid(session_id)
    return _transform_continue_unit(unit, f"--resume {session_id}")


def validate_notification_target(
    state_dir: Path,
    chat_id: str,
    *,
    expected_uid: int,
    allow_multiple_chats: bool = False,
) -> str:
    if not re.fullmatch(r"\d+", chat_id):
        raise ValueError("invalid chat ID")
    before = state_dir.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise ValueError("channel state root must be a real directory")
    dir_fd = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(dir_fd)
        if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
            raise ValueError("channel state root changed during validation")
        if stat.S_IMODE(opened.st_mode) != 0o700 or opened.st_uid != expected_uid:
            raise ValueError("channel state root must be owned by the service user with mode 0700")
        env_text = _read_secure_at(dir_fd, ".env", expected_uid, 0o600, "channel state")
        access_text = _read_secure_at(dir_fd, "access.json", expected_uid, 0o600, "channel state")
    finally:
        os.close(dir_fd)

    token_lines = [
        line.split("=", 1)[1].strip()
        for line in env_text.splitlines()
        if line.startswith("TELEGRAM_BOT_TOKEN=")
    ]
    if len(token_lines) != 1 or not TOKEN_RE.fullmatch(token_lines[0]):
        raise ValueError("invalid Telegram bot token state")

    access = json.loads(access_text)
    if access.get("dmPolicy") != "allowlist":
        raise ValueError("dmPolicy must be allowlist")
    allowed = access.get("allowFrom")
    if not isinstance(allowed, list) or not all(
        isinstance(value, str) and re.fullmatch(r"\d+", value)
        for value in allowed
    ):
        raise ValueError("invalid Telegram allowlist")
    if len(set(allowed)) != len(allowed):
        raise ValueError("Telegram allowlist must not contain duplicates")
    if not allow_multiple_chats and len(allowed) != 1:
        raise ValueError("exactly one allowlisted chat is required by default")
    if chat_id not in allowed:
        raise ValueError("chat is not authorized")
    return token_lines[0]


def validate_selected_session(config: ResetConfig, session_id: str) -> Path:
    """Independently revalidate a resume target inside the root-configured sessions directory.

    The control MCP already resolved the UUID from a user-private snapshot, but root repeats the
    whole check: the path is composed here from the root configuration, never received, and the
    file must still be a plain, non-symlinked, service-owned, non-world-writable transcript.
    """
    if not isinstance(session_id, str) or not UUID_RE.fullmatch(session_id):
        raise ValueError("invalid session UUID")

    directory = config.project_sessions
    try:
        directory_info = directory.lstat()
    except OSError as exc:
        raise ValueError("configured project sessions directory is unreadable") from exc
    if stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
        raise ValueError("configured project sessions path must be a real directory")

    path = directory / f"{session_id}.jsonl"
    try:
        info = path.lstat()
    except OSError as exc:
        raise ValueError("selected session transcript does not exist") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ValueError("selected session transcript must not be a symlink")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("selected session transcript must be a regular file")
    if info.st_uid != config.service_uid:
        raise ValueError("selected session transcript has the wrong owner")
    if info.st_nlink != 1:
        raise ValueError("selected session transcript must have one hardlink")
    if info.st_size == 0:
        raise ValueError("selected session transcript is empty")
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise ValueError("selected session transcript must not be group or world writable")
    return path


def _validate_absolute_no_traversal(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    if ".." in path.parts:
        raise ValueError(f"{label} must not contain path traversal")
    return value


def _validate_receipt_payload(payload: Any, session_id: str) -> None:
    """A receipt only counts when every field matches the exact expected boot."""
    if not isinstance(payload, dict):
        raise ValueError("session start receipt must be a JSON object")
    expected_fields = {"protocol", "version", "event", "source", "session_id", "cwd", "transcript_path"}
    if set(payload) != expected_fields:
        raise ValueError("session start receipt has unexpected fields")
    if isinstance(payload.get("protocol"), bool) or payload.get("protocol") != PROTOCOL_VERSION:
        raise ValueError("session start receipt has the wrong protocol")
    if isinstance(payload.get("version"), bool) or payload.get("version") != RECEIPT_VERSION:
        raise ValueError("session start receipt has the wrong version")
    if payload.get("event") != "SessionStart":
        raise ValueError("session start receipt is not a SessionStart event")
    if payload.get("source") != "startup":
        raise ValueError("session start receipt is not from startup")
    if payload.get("session_id") != session_id:
        raise ValueError("session start receipt is for a different session")
    _validate_absolute_no_traversal(payload.get("cwd"), "receipt cwd")
    transcript_path = _validate_absolute_no_traversal(payload.get("transcript_path"), "receipt transcript_path")
    if Path(transcript_path).name != f"{session_id}.jsonl":
        raise ValueError("receipt transcript_path does not match the session")


def _open_receipt_dir(config: ResetConfig) -> tuple[int, os.stat_result]:
    """Open the configured receipt directory with the owner/mode pinned at every step."""
    path = config.session_start_receipt_dir
    try:
        before = path.lstat()
    except OSError as exc:
        raise ValueError("session start receipt directory is unreadable") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise ValueError("session start receipt directory must be a real directory")
    if before.st_uid != config.service_uid or stat.S_IMODE(before.st_mode) != 0o700:
        raise ValueError("session start receipt directory must be owned by the service user with mode 0700")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
    except Exception:
        os.close(fd)
        raise
    if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
        os.close(fd)
        raise ValueError("session start receipt directory changed during validation")
    if opened.st_uid != config.service_uid or stat.S_IMODE(opened.st_mode) != 0o700:
        os.close(fd)
        raise ValueError("session start receipt directory must be owned by the service user with mode 0700")
    return fd, opened


def _read_session_receipt(config: ResetConfig, session_id: str) -> dict[str, Any] | None:
    """Read and fully validate the receipt for one exact session, or None while it is absent."""
    _validate_uuid(session_id)
    dir_fd, _ = _open_receipt_dir(config)
    try:
        name = f"{session_id}.json"
        try:
            before = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(before.st_mode):
            raise ValueError("session start receipt must not be a symlink")
        _validate_file_info(before, config.service_uid, 0o600, "session start receipt")
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
        try:
            opened = os.fstat(fd)
            _validate_file_info(opened, config.service_uid, 0o600, "session start receipt")
            if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
                raise ValueError("session start receipt changed during validation")
            text = _read_fd_text(fd, MAX_RECEIPT_BYTES, "session start receipt")
        finally:
            os.close(fd)
        payload = json.loads(text)
        _validate_receipt_payload(payload, session_id)
        return payload
    finally:
        os.close(dir_fd)


def _remove_session_receipt(config: ResetConfig, session_id: str) -> None:
    """Securely remove only the exact expected receipt; anything else is preserved or refused."""
    _validate_uuid(session_id)
    dir_fd, _ = _open_receipt_dir(config)
    try:
        name = f"{session_id}.json"
        try:
            before = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(before.st_mode):
            raise ValueError("session start receipt must not be a symlink")
        _validate_file_info(before, config.service_uid, 0o600, "session start receipt")
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
        try:
            opened = os.fstat(fd)
            _validate_file_info(opened, config.service_uid, 0o600, "session start receipt")
            if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
                raise ValueError("session start receipt changed during validation")
            payload = json.loads(_read_fd_text(fd, MAX_RECEIPT_BYTES, "session start receipt"))
        finally:
            os.close(fd)
        _validate_receipt_payload(payload, session_id)
        os.unlink(name, dir_fd=dir_fd)
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


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
    unit = _read_secure_regular(config.unit_path, 0, 0o644, "service unit")
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


def _service_health(
    config: ResetConfig,
    expected_session_id: str,
    *,
    flag: str = "--session-id",
    require_workers: bool = True,
) -> bool:
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
    claude_ok = any(f"{flag} {expected_session_id}" in command for command in descendants)
    poller_ok = any(config.poller_process_marker in command for command in descendants)
    required_ok = all(any(marker in command for command in descendants) for marker in config.required_process_markers)
    return claude_ok and (not require_workers or (poller_ok and required_ok))


def _wait_for_fresh_session(config: ResetConfig, session_id: str, timeout: float) -> None:
    """A fresh session injects no prompt, so readiness is a secure SessionStart receipt
    plus the exact process, the official poller, and every required worker. No transcript
    content is ever read and no LLM is involved."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _read_session_receipt(config, session_id) is not None and _service_health(config, session_id):
            return
        time.sleep(1)
    raise TimeoutError("fresh Claude Code session did not become ready")


def _wait_for_resumed_session(config: ResetConfig, session_id: str, timeout: float) -> None:
    """A resume injects no prompt, so readiness is the exact target plus every required worker."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _service_health(config, session_id, flag="--resume"):
            return
        time.sleep(1)
    raise TimeoutError("resumed Claude Code session did not become ready")


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
    opener = urllib.request.build_opener(_NoRedirectHandler())
    with opener.open(request, timeout=20) as response:
        raw = response.read(MAX_TELEGRAM_RESPONSE_BYTES + 1)
    if len(raw) > MAX_TELEGRAM_RESPONSE_BYTES:
        raise RuntimeError("Telegram response too large")
    result = json.loads(raw.decode("utf-8"))
    message_id = result.get("result", {}).get("message_id")
    if (
        result.get("ok") is not True
        or not isinstance(message_id, int)
        or isinstance(message_id, bool)
        or message_id < 1
    ):
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


def reset_session(
    config: ResetConfig,
    *,
    chat_id: str | None,
    request_id: str | None,
    timeout: float,
) -> dict[str, Any]:
    if os.geteuid() != 0:
        raise PermissionError("session reset helper must run as root")
    token: str | None = None
    if (request_id is None) != (chat_id is None):
        raise ValueError("request_id and chat_id must be provided together")
    if chat_id is not None:
        token = validate_notification_target(
            config.channel_state,
            chat_id,
            expected_uid=config.service_uid,
            allow_multiple_chats=config.allow_multiple_chats,
        )

    config.lock_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    lock_fd = os.open(config.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another session reset is already running") from exc

        if request_id is not None and chat_id is not None:
            claimed = claim_request(
                REQUEST_STATE_ROOT,
                request_id,
                chat_id,
                action="reset",
                target_session=None,
            )
            if not claimed["claimed"]:
                receipt = claimed["receipt"]
                return {
                    "status": "duplicate_request",
                    "request_id": request_id,
                    "prior_status": receipt.get("status"),
                    "old_session": receipt.get("old_session"),
                    "new_session": receipt.get("new_session"),
                    "completion_message_id": receipt.get("completion_message_id"),
                }

        original_unit = _read_canonical_unit(config)
        old_session = _latest_session_id(config)
        new_session = str(uuid.uuid4())
        phase = "prepare_receipt"
        try:
            # Drop any stale receipt for the exact new session before the restart that would
            # recreate it: readiness must come from this boot, never from a leftover.
            _remove_session_receipt(config, new_session)
            phase = "write_fresh_unit"
            _atomic_write(
                config.unit_path,
                fresh_unit_from_continue(original_unit, new_session),
            )
            phase = "restart_fresh_service"
            _reload_and_restart(config)
            phase = "wait_fresh_readiness"
            _wait_for_fresh_session(config, new_session, timeout)
            phase = "restore_canonical_unit"
            _atomic_write(config.unit_path, original_unit)
            phase = "reload_canonical_unit"
            _reload_only()
            phase = "post_restore_process_check"
            # Full process/poller/worker readiness was already proven immediately above.
            # Restoring the canonical unit is a file write plus daemon-reload only; it does
            # not restart the running Claude process. Re-check only the exact pinned Claude
            # argv here so transient sidecar churn cannot misclassify a successful reset.
            if not _service_health(config, new_session, require_workers=False):
                raise RuntimeError("post-restore health check failed")
            # The fresh session is proven and steady state is restored; the receipt has served
            # its purpose and must not linger as a stale artifact for a future boot.
            phase = "cleanup_receipt"
            _remove_session_receipt(config, new_session)
        except Exception as exc:
            try:
                _remove_session_receipt(config, new_session)
            except Exception:
                pass
            recovered = _recover_old(config, original_unit, old_session)
            if token is not None and chat_id is not None:
                status = "previous session restored" if recovered else "manual recovery required"
                try:
                    _notify(token, chat_id, f"Session reset failed; {status}.")
                except Exception:
                    pass
            if request_id is not None:
                try:
                    finish_request(
                        REQUEST_STATE_ROOT,
                        request_id,
                        "failed",
                        {
                            "old_session": old_session,
                            "recovered": recovered,
                            "failure_phase": phase,
                            "failure_type": type(exc).__name__,
                        },
                    )
                except Exception:
                    pass
            raise RuntimeError(f"session reset failed at {phase}") from exc

        completion_id: int | None = None
        if token is not None and chat_id is not None:
            try:
                completion_id = _notify(
                    token,
                    chat_id,
                    f"Session reset complete. New session: {new_session[:8]}…",
                )
            except Exception:
                completion_id = None
        result = {
            "status": "reset_complete",
            "old_session": old_session,
            "new_session": new_session,
            "completion_message_id": completion_id,
        }
        if request_id is not None:
            try:
                finish_request(
                    REQUEST_STATE_ROOT,
                    request_id,
                    "complete",
                    {
                        "old_session": old_session,
                        "new_session": new_session,
                        "completion_message_id": completion_id,
                    },
                )
                result["receipt_persisted"] = True
            except Exception as exc:
                # The service switch already succeeded. A receipt that cannot be persisted must not
                # reclassify the action as failed; the in_progress claim still blocks duplicates.
                result["receipt_persisted"] = False
                result["receipt_error"] = str(exc)
                if token is not None and chat_id is not None:
                    try:
                        _notify(
                            token,
                            chat_id,
                            "Session reset complete, but the request receipt could not be persisted.",
                        )
                    except Exception:
                        pass
            result["request_id"] = request_id
        return result
    finally:
        os.close(lock_fd)


def resume_session(
    config: ResetConfig,
    *,
    session_id: str,
    current_session_id: str,
    chat_id: str | None,
    request_id: str | None,
    timeout: float,
) -> dict[str, Any]:
    """Switch the service to an exact previously recorded session, then restore steady state.

    The canonical unit stays `--continue`. This transforms it to `--resume <uuid>` for exactly one
    restart, verifies the target process plus the official poller, renderer, and control workers,
    and then rewrites the unit back to `--continue` with a daemon-reload only, so the next ordinary
    restart continues the session the user just resumed instead of re-pinning it.

    `current_session_id` is the session the service is believed to be on right now; it is validated
    as an exact UUID with a real transcript and becomes the old_session/rollback authority, so
    recovery never guesses from mtimes.
    """
    if os.geteuid() != 0:
        raise PermissionError("session resume helper must run as root")
    _validate_uuid(session_id)
    _validate_uuid(current_session_id)
    if (request_id is None) != (chat_id is None):
        raise ValueError("request_id and chat_id must be provided together")

    token: str | None = None
    if chat_id is not None:
        token = validate_notification_target(
            config.channel_state,
            chat_id,
            expected_uid=config.service_uid,
            allow_multiple_chats=config.allow_multiple_chats,
        )
    validate_selected_session(config, session_id)
    validate_selected_session(config, current_session_id)

    config.lock_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    lock_fd = os.open(config.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another session reset is already running") from exc

        if request_id is not None and chat_id is not None:
            claimed = claim_request(
                REQUEST_STATE_ROOT,
                request_id,
                chat_id,
                action="resume",
                target_session=session_id,
            )
            if not claimed["claimed"]:
                receipt = claimed["receipt"]
                return {
                    "status": "duplicate_request",
                    "request_id": request_id,
                    "prior_status": receipt.get("status"),
                    "old_session": receipt.get("old_session"),
                    "new_session": receipt.get("new_session"),
                    "completion_message_id": receipt.get("completion_message_id"),
                }

        original_unit: str | None = None
        old_session: str | None = None
        mutation_started = False
        try:
            original_unit = _read_canonical_unit(config)
            old_session = current_session_id
            if session_id == old_session:
                raise ValueError("selected session is already the active session")

            mutation_started = True
            _atomic_write(config.unit_path, resume_unit_from_continue(original_unit, session_id))
            _reload_and_restart(config)
            _wait_for_resumed_session(config, session_id, timeout)
            # Restoring the canonical unit is a file write plus daemon-reload only; it does not
            # restart the process, so the running Claude still carries `--resume <id>` here.
            # The check below therefore still sees the target flag. It guards the narrow case
            # where the service was restarted for an unrelated reason between readiness and
            # steady-state restoration, which would have booted `--continue` instead.
            _atomic_write(config.unit_path, original_unit)
            _reload_only()
            if not _service_health(config, session_id, flag="--resume"):
                raise RuntimeError("post-restore health check failed")
        except Exception as exc:
            # Before the unit mutation begins, there is nothing to roll back. Once mutation starts,
            # recovery must explicitly restore the exact previously active session.
            recovered = not mutation_started
            if mutation_started and original_unit is not None and old_session is not None:
                recovered = _recover_old(config, original_unit, old_session)
            if token is not None and chat_id is not None:
                status = (
                    "no service change was made"
                    if not mutation_started
                    else "previous session restored" if recovered
                    else "manual recovery required"
                )
                try:
                    _notify(token, chat_id, f"Session resume failed; {status}.")
                except Exception:
                    pass
            if request_id is not None:
                try:
                    finish_request(
                        REQUEST_STATE_ROOT,
                        request_id,
                        "failed",
                        {"old_session": old_session, "recovered": recovered},
                    )
                except Exception:
                    pass
            raise RuntimeError("session resume failed") from exc

        # The switch already succeeded. A failed notification is recorded, never rolled back.
        completion_id: int | None = None
        if token is not None and chat_id is not None:
            try:
                completion_id = _notify(
                    token,
                    chat_id,
                    f"Session resumed. Now on session: {session_id[:8]}\u2026",
                )
            except Exception:
                completion_id = None

        result: dict[str, Any] = {
            "status": "resume_complete",
            "old_session": old_session,
            "new_session": session_id,
            "completion_message_id": completion_id,
        }
        if request_id is not None:
            try:
                finish_request(
                    REQUEST_STATE_ROOT,
                    request_id,
                    "complete",
                    {
                        "old_session": old_session,
                        "new_session": session_id,
                        "completion_message_id": completion_id,
                    },
                )
                result["receipt_persisted"] = True
            except Exception as exc:
                # The session switch already succeeded. A receipt that cannot be persisted must not
                # reclassify the action as failed; the in_progress claim still blocks duplicates.
                result["receipt_persisted"] = False
                result["receipt_error"] = str(exc)
                if token is not None and chat_id is not None:
                    try:
                        _notify(
                            token,
                            chat_id,
                            "Session resume complete, but the request receipt could not be persisted.",
                        )
                    except Exception:
                        pass
            result["request_id"] = request_id
        return result
    finally:
        os.close(lock_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Reset or resume a Telegram-connected Claude Code session"
    )
    parser.add_argument(
        "--config",
        default=os.environ.get("CLAUDE_SESSION_RESET_CONFIG", str(DEFAULT_CONFIG_PATH)),
    )
    parser.add_argument(
        "--capabilities",
        action="store_true",
        help="print the supported protocol and actions, then exit without touching any state",
    )
    parser.add_argument("--protocol", type=int, default=PROTOCOL_VERSION)
    parser.add_argument("--action", choices=SUPPORTED_ACTIONS, default="reset")
    parser.add_argument("--session-id", help="exact resume target; only valid with --action resume")
    parser.add_argument(
        "--current-session-id",
        help="exact currently active session; only valid with --action resume",
    )
    parser.add_argument("--chat-id")
    parser.add_argument("--request-id")
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args(argv)

    if args.capabilities:
        print(json.dumps(capabilities(), separators=(",", ":")))
        return 0

    try:
        if args.protocol != PROTOCOL_VERSION:
            raise ValueError("unsupported helper protocol version")
        if args.action == "reset":
            if args.session_id is not None:
                raise ValueError("--session-id is only valid with --action resume")
            if args.current_session_id is not None:
                raise ValueError("--current-session-id is only valid with --action resume")
        if args.action == "resume":
            if args.session_id is None:
                raise ValueError("--action resume requires --session-id")
            _validate_uuid(args.session_id)
            if args.current_session_id is None:
                raise ValueError("--action resume requires --current-session-id")
            _validate_uuid(args.current_session_id)

        config = load_config(Path(args.config))
        if args.action == "resume":
            result = resume_session(
                config,
                session_id=args.session_id,
                current_session_id=args.current_session_id,
                chat_id=args.chat_id,
                request_id=args.request_id,
                timeout=args.timeout,
            )
        else:
            result = reset_session(
                config,
                chat_id=args.chat_id,
                request_id=args.request_id,
                timeout=args.timeout,
            )
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
