#!/usr/bin/env python3
"""Persist Claude Code statusLine rate-limit windows to a private local snapshot."""

from __future__ import annotations

import argparse
import json
import math
import os
import stat
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

MAX_STDIN_BYTES = 512 * 1024
SNAPSHOT_VERSION = 1
WINDOWS = ("five_hour", "seven_day")


def _percentage(value: Any) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("invalid used percentage")
    number = float(value)
    if number < 0 or number > 100:
        raise ValueError("invalid used percentage")
    return number


def _reset(value: Any, captured_at: int) -> int:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        if float(value).is_integer():
            reset_at = int(value)
            if captured_at - 3600 <= reset_at <= captured_at + 8 * 24 * 3600:
                return reset_at
    raise ValueError("invalid reset timestamp")


def build_snapshot(payload: Any, *, captured_at: int | None = None) -> dict[str, Any] | None:
    if not isinstance(payload, Mapping):
        raise ValueError("statusLine input must be an object")
    limits = payload.get("rate_limits")
    if limits is None:
        return None
    if not isinstance(limits, Mapping):
        raise ValueError("rate_limits must be an object")
    captured = int(time.time()) if captured_at is None else int(captured_at)
    windows: dict[str, Any] = {}
    for name in WINDOWS:
        raw = limits.get(name)
        if raw is None:
            continue
        if not isinstance(raw, Mapping):
            raise ValueError("rate-limit window must be an object")
        unknown = set(raw) - {"used_percentage", "resets_at"}
        if unknown:
            raise ValueError("rate-limit window has unexpected fields")
        windows[name] = {
            "used_percentage": _percentage(raw.get("used_percentage")),
            "resets_at": _reset(raw.get("resets_at"), captured),
        }
    if "five_hour" not in windows and "seven_day" not in windows:
        return None
    return {
        "version": SNAPSHOT_VERSION,
        "captured_at": captured,
        "windows": windows,
    }


def _open_private_dir(path: Path, uid: int) -> int:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("snapshot directory must be absolute")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        opened = os.fstat(fd)
        if opened.st_uid != uid or stat.S_IMODE(opened.st_mode) != 0o700:
            raise ValueError("snapshot directory must be user-owned mode 0700")
        return fd
    except OSError as exc:
        os.close(fd)
        raise ValueError("snapshot directory is unreadable or contains a symlink") from exc
    except Exception:
        os.close(fd)
        raise


def write_snapshot(path: Path, snapshot: Mapping[str, Any], *, uid: int | None = None) -> None:
    expected_uid = os.geteuid() if uid is None else uid
    if not path.is_absolute() or ".." in path.parts or path.name in {"", ".", ".."}:
        raise ValueError("snapshot path must be absolute")
    directory_fd = _open_private_dir(path.parent, expected_uid)
    temp_name = f".{path.name}.tmp.{uuid.uuid4().hex}"
    fd: int | None = None
    try:
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        data = (json.dumps(snapshot, sort_keys=True, separators=(",", ":")) + "\n").encode()
        os.write(fd, data)
        os.fsync(fd)
        info = os.fstat(fd)
        if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError("snapshot file metadata is invalid")
        os.close(fd)
        fd = None
        os.rename(temp_name, path.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temp_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        if os.geteuid() == 0:
            raise PermissionError("usage snapshot writer must not run as root")
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            raise ValueError("statusLine input is too large")
        payload = json.loads(raw.decode())
        snapshot = build_snapshot(payload)
        if snapshot is not None:
            write_snapshot(Path(args.output), snapshot)
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
