#!/usr/bin/env python3
"""Write a secure SessionStart receipt for a freshly started Claude Code session.

This executable is the Claude Code command hook for SessionStart. It runs as the service
user (never root), reads a bounded JSON object from stdin, validates every field against
the exact boot it must attest, and atomically publishes a 0600 single-link receipt named
by the exact session UUID into the user-owned 0700 directory from the root configuration.
The root reset helper treats a matching receipt plus the exact process, poller, and
required workers as the only evidence that a fresh session is ready; no transcript content
and no LLM prompt are involved.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 4
RECEIPT_VERSION = 1
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MAX_STDIN_BYTES = 64 * 1024
_REQUIRED_HOOK_FIELDS = {"hook_event_name", "source", "session_id", "cwd", "transcript_path"}
_OPTIONAL_HOOK_FIELDS = {"model", "agent_type", "session_title"}
_ALLOWED_HOOK_FIELDS = _REQUIRED_HOOK_FIELDS | _OPTIONAL_HOOK_FIELDS


def _validate_absolute_no_traversal(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    if ".." in path.parts:
        raise ValueError(f"{label} must not contain path traversal")
    return value


def _validate_file_info(info: os.stat_result, expected_uid: int, mode: int, label: str) -> None:
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"{label} must be a regular file")
    if stat.S_IMODE(info.st_mode) != mode:
        raise ValueError(f"{label} must have mode {mode:04o}")
    if info.st_uid != expected_uid:
        raise ValueError(f"{label} has the wrong owner")
    if info.st_nlink != 1:
        raise ValueError(f"{label} must have one hardlink")


def _validate_input(payload: Any) -> dict[str, Any]:
    """Every field is pinned to the exact SessionStart startup boot; anything else is spoofed."""
    if not isinstance(payload, dict):
        raise ValueError("hook input must be a JSON object")
    unknown = set(payload) - _ALLOWED_HOOK_FIELDS
    if unknown:
        raise ValueError("hook input has unknown fields: " + ", ".join(sorted(unknown)))
    missing = _REQUIRED_HOOK_FIELDS - set(payload)
    if missing:
        raise ValueError("hook input is missing fields: " + ", ".join(sorted(missing)))
    for field in _OPTIONAL_HOOK_FIELDS:
        value = payload.get(field)
        if value is not None and (not isinstance(value, str) or len(value) > 512):
            raise ValueError(f"hook input field {field} must be a bounded string")
    if payload.get("hook_event_name") != "SessionStart":
        raise ValueError("hook event must be SessionStart")
    if payload.get("source") != "startup":
        raise ValueError("hook source must be startup")
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not UUID_RE.fullmatch(session_id):
        raise ValueError("invalid session UUID")
    _validate_absolute_no_traversal(payload.get("cwd"), "cwd")
    transcript_path = _validate_absolute_no_traversal(payload.get("transcript_path"), "transcript_path")
    if Path(transcript_path).name != f"{session_id}.jsonl":
        raise ValueError("transcript_path does not match the session UUID")
    return payload


def _receipt_payload(validated: dict[str, Any]) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL_VERSION,
        "version": RECEIPT_VERSION,
        "event": validated["hook_event_name"],
        "source": validated["source"],
        "session_id": validated["session_id"],
        "cwd": validated["cwd"],
        "transcript_path": validated["transcript_path"],
    }


def _open_owned_dir(dir_path: Path, expected_uid: int, label: str) -> tuple[int, os.stat_result]:
    """Open a real, non-symlinked, user-owned 0700 directory with the identity pinned twice."""
    before = dir_path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise ValueError(f"{label} must be a real directory")
    if before.st_uid != expected_uid or stat.S_IMODE(before.st_mode) != 0o700:
        raise ValueError(f"{label} must be user-owned with mode 0700")
    fd = os.open(dir_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
    except Exception:
        os.close(fd)
        raise
    if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
        os.close(fd)
        raise ValueError(f"{label} changed during validation")
    if opened.st_uid != expected_uid or stat.S_IMODE(opened.st_mode) != 0o700:
        os.close(fd)
        raise ValueError(f"{label} must be user-owned with mode 0700")
    return fd, opened


def write_session_receipt(dir_path: Path, payload: dict[str, Any], *, expected_uid: int) -> Path:
    """Atomically publish the receipt for the exact session, refusing to overwrite anything."""
    validated = _validate_input(payload)
    session_id = validated["session_id"]
    dir_fd, _ = _open_owned_dir(dir_path, expected_uid, "session start receipt directory")
    final_name = f"{session_id}.json"
    temp_name = f".{session_id}.tmp.{uuid.uuid4().hex}"
    fd: int | None = None
    try:
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        data = (json.dumps(_receipt_payload(validated), sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if written <= 0:
                raise OSError("short receipt write")
            offset += written
        os.fsync(fd)
        _validate_file_info(os.fstat(fd), expected_uid, 0o600, "temporary receipt")
        os.close(fd)
        fd = None
        try:
            os.link(temp_name, final_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        except FileExistsError as exc:
            raise ValueError("session start receipt already exists") from exc
        os.unlink(temp_name, dir_fd=dir_fd)
        os.fsync(dir_fd)
        return dir_path / final_name
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temp_name, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        os.close(dir_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a secure Claude Code SessionStart receipt")
    parser.add_argument(
        "--directory",
        required=True,
        help="Absolute service-user-owned 0700 receipt directory",
    )
    args = parser.parse_args(argv)
    try:
        if os.geteuid() == 0:
            raise PermissionError("session start receipt writer must not run as root")
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            raise ValueError("hook input is too large")
        payload = json.loads(raw.decode("utf-8"))
        directory = Path(_validate_absolute_no_traversal(args.directory, "receipt directory"))
        path = write_session_receipt(directory, payload, expected_uid=os.geteuid())
        print(json.dumps({"status": "written", "receipt": str(path)}, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
