#!/usr/bin/env python3
"""Fail-closed Claude Code compatibility preflight for Memory Harness v0.4."""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

MIN_VERSION = (2, 1, 196)
VERSION_RE = re.compile(r"(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)")
SESSION_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
PROMPT_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
MAX_SETTINGS_BYTES = 64 * 1024
MAX_PAYLOAD_BYTES = 256 * 1024


def parse_version(text: str) -> tuple[int, int, int]:
    match = VERSION_RE.search(text)
    if match is None:
        raise ValueError("Claude Code version is not parseable")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_secure_json(path: Path, *, max_bytes: int, label: str) -> Any:
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError(f"{label} path must be one canonical absolute path")
    before = path.lstat()
    expected_uid = os.getuid()
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
            or before.st_nlink != 1 or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) & 0o022 or before.st_size < 2
            or before.st_size > max_bytes):
        raise ValueError(f"unsafe {label}")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev != before.st_dev or opened.st_ino != before.st_ino
                or opened.st_nlink != 1 or opened.st_uid != expected_uid
                or stat.S_IMODE(opened.st_mode) & 0o022 or opened.st_size != before.st_size):
            raise ValueError(f"{label} changed during read")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(fd, remaining)
            if not chunk:
                raise ValueError(f"short {label} read")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(fd)
        if after.st_dev != opened.st_dev or after.st_ino != opened.st_ino or after.st_size != opened.st_size or after.st_mtime_ns != opened.st_mtime_ns:
            raise ValueError(f"{label} changed during read")
    finally:
        os.close(fd)
    return json.loads(b"".join(chunks).decode("utf-8"), object_pairs_hook=_unique_object)


def validate_settings(path: Path) -> Path:
    value = _read_secure_json(path, max_bytes=MAX_SETTINGS_BYTES, label="Claude settings")
    if not isinstance(value, dict) or "autoMemoryDirectory" not in value:
        raise ValueError("explicit autoMemoryDirectory is required")
    configured = value.get("autoMemoryDirectory")
    if not isinstance(configured, str) or not configured or "\0" in configured:
        raise ValueError("invalid autoMemoryDirectory")
    memory = Path(configured)
    if not memory.is_absolute() or memory.resolve() != memory:
        raise ValueError("autoMemoryDirectory must be one canonical absolute path")
    info = memory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022):
        raise ValueError("unsafe autoMemoryDirectory")
    fd = os.open(memory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev != info.st_dev or opened.st_ino != info.st_ino
                or opened.st_uid != os.getuid() or stat.S_IMODE(opened.st_mode) & 0o022):
            raise ValueError("autoMemoryDirectory changed during validation")
    finally:
        os.close(fd)
    return memory


def validate_stop_payload(value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError("Stop payload must be an object")
    required = {"session_id", "prompt_id", "hook_event_name", "stop_hook_active", "last_assistant_message", "background_tasks", "session_crons"}
    if not required.issubset(value):
        raise ValueError("Stop payload is missing required compatibility fields")
    if (not isinstance(value["session_id"], str) or SESSION_RE.fullmatch(value["session_id"]) is None
            or not isinstance(value["prompt_id"], str) or PROMPT_RE.fullmatch(value["prompt_id"]) is None
            or value["hook_event_name"] != "Stop"
            or type(value["stop_hook_active"]) is not bool
            or not isinstance(value["last_assistant_message"], str)
            or not isinstance(value["background_tasks"], list)
            or not isinstance(value["session_crons"], list)):
        raise ValueError("invalid Stop payload compatibility shape")


def _open_private_directory(path: Path) -> int:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("private directory must be absolute and non-traversing")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            try:
                before = os.stat(part, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=fd)
                before = os.stat(part, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
                raise ValueError("private directory path contains a non-directory")
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            opened = os.fstat(next_fd)
            if opened.st_dev != before.st_dev or opened.st_ino != before.st_ino:
                os.close(next_fd)
                raise ValueError("private directory changed during traversal")
            os.close(fd)
            fd = next_fd
        final = os.fstat(fd)
        if final.st_uid != os.getuid() or stat.S_IMODE(final.st_mode) != 0o700:
            raise ValueError("private directory must be user-owned mode 0700")
        return fd
    except Exception:
        os.close(fd)
        raise


def capture_stop_payload(target: Path, raw: bytes) -> None:
    if not target.is_absolute() or target.name in {"", ".", ".."} or len(raw) < 2 or len(raw) > MAX_PAYLOAD_BYTES:
        raise ValueError("invalid Stop payload capture target or size")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    validate_stop_payload(value)
    dir_fd = _open_private_directory(target.parent)
    temp_name = f".{target.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp"
    try:
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        try:
            offset = 0
            while offset < len(raw):
                written = os.write(fd, raw[offset:])
                if written <= 0:
                    raise OSError("short Stop payload capture write")
                offset += written
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(temp_name, target.name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        os.fsync(dir_fd)
    except Exception:
        try:
            os.unlink(temp_name, dir_fd=dir_fd)
        except OSError:
            pass
        raise
    finally:
        os.close(dir_fd)


def check_version(claude: Path) -> tuple[int, int, int]:
    result = subprocess.run([str(claude), "--version"], capture_output=True, text=True, timeout=10, check=False)
    if result.returncode != 0:
        raise RuntimeError("Claude Code version probe failed")
    version = parse_version(result.stdout + "\n" + result.stderr)
    if version < MIN_VERSION:
        raise RuntimeError(f"Claude Code {version} is below required {MIN_VERSION}")
    return version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--claude", type=Path)
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--stop-payload", type=Path)
    parser.add_argument("--capture-stop-payload", type=Path)
    args = parser.parse_args(argv)
    if args.capture_stop_payload is not None:
        capture_stop_payload(args.capture_stop_payload, sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1))
        print(json.dumps({"status": "captured", "path": str(args.capture_stop_payload)}, sort_keys=True))
        return 0
    if args.claude is None or args.settings is None:
        parser.error("--claude and --settings are required outside capture mode")
    version = check_version(args.claude)
    memory = validate_settings(args.settings)
    payload_checked = False
    if args.stop_payload is not None:
        payload = _read_secure_json(args.stop_payload, max_bytes=MAX_PAYLOAD_BYTES, label="Stop payload")
        validate_stop_payload(payload)
        payload_checked = True
    print(json.dumps({
        "status": "compatible",
        "compatible": True,
        "version": ".".join(str(part) for part in version),
        "minimum_version": ".".join(str(part) for part in MIN_VERSION),
        "auto_memory_directory": str(memory),
        "stop_payload_checked": payload_checked,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
