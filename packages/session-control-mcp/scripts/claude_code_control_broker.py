#!/usr/bin/env python3
"""Root-owned socket broker for bounded Claude Telegram control actions."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import pwd
import re
import socket
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

BROKER_PROTOCOL = 1
HELPER_PROTOCOL = 4
DEFAULT_CONFIG = Path("/etc/claude-code-telegram-kit/reset.json")
DEFAULT_HELPER = Path("/usr/local/sbin/claude-code-session-reset")
SYSTEMD_RUN = "/usr/bin/systemd-run"
MAX_REQUEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
SOCKET_TIMEOUT_SECONDS = 5.0
RATE_STATE = Path("/run/claude-code-telegram-kit/mutation-rate.json")
RATE_WINDOW_SECONDS = 60
RATE_BURST = 12
MAX_PENDING_JOBS = 4
MODELS = {"opus", "sonnet", "haiku", "inherit"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
DIGITS_RE = re.compile(r"^[0-9]+$")
UNIT_RE = re.compile(r"^claude-session-reset(?:-(?:resume|model))?-[0-9a-f]{24}$")
Runner = Callable[[list[str], float], subprocess.CompletedProcess[str]]


def _strict_json(text: str) -> Any:
    def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    return json.loads(text, object_pairs_hook=strict_object)


def _secure_file(path: Path, modes: tuple[int, ...], label: str) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError(f"{label} is not a regular file")
    if info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) not in modes:
        raise ValueError(f"{label} ownership or mode is invalid")
    return info


def _load_service_uid(config_path: Path) -> int:
    _secure_file(config_path, (0o600, 0o644), "broker config")
    raw = _strict_json(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("service_user"), str):
        raise ValueError("invalid broker config")
    account = pwd.getpwnam(raw["service_user"])
    if account.pw_uid == 0:
        raise ValueError("service user must be unprivileged")
    return account.pw_uid


def _request_id(action: str, request: dict[str, Any]) -> str:
    chat = request["chat_id"]
    message = request["message_id"]
    if action == "reset":
        seed = f"{chat}:{message}"
    elif action == "resume":
        seed = f"resume:{chat}:{message}:{request['current_session_id']}"
    else:
        seed = f"model:{chat}:{message}:{request['model']}"
    return hashlib.sha256(seed.encode()).hexdigest()[:24]

def _run(argv: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )


def _pending_jobs(run: Runner) -> int:
    result = run([
        "/usr/bin/systemctl", "list-units", "--type=service",
        "--state=activating,running", "--no-legend", "--plain",
        "claude-session-reset*.service",
    ], 5.0)
    if result.returncode != 0:
        raise RuntimeError("unable to count control jobs")
    return sum(1 for line in result.stdout.splitlines() if line.strip())


def _reserve_mutation(
    run: Runner,
    *,
    state_path: Path = RATE_STATE,
    now: float | None = None,
    burst: int = RATE_BURST,
    expected_uid: int = 0,
) -> None:
    if _pending_jobs(run) >= MAX_PENDING_JOBS:
        raise RuntimeError("too many pending control jobs")
    current = time.time() if now is None else now
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    parent_info = state_path.parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode) or parent_info.st_uid != expected_uid or (parent_info.st_mode & 0o022) != 0:
        raise ValueError("mutation rate directory is not secure")
    lock_path = state_path.with_suffix(".lock")
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lock_info = os.fstat(lock_fd)
        if lock_info.st_uid != expected_uid or lock_info.st_nlink != 1 or stat.S_IMODE(lock_info.st_mode) != 0o600:
            raise ValueError("mutation rate lock is not secure")
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        timestamps: list[float] = []
        try:
            info = state_path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("mutation rate state is not secure")
            raw = _strict_json(state_path.read_text())
            values = raw.get("timestamps") if isinstance(raw, dict) and set(raw) == {"timestamps"} else None
            if not isinstance(values, list):
                raise ValueError("invalid mutation rate state")
            for value in values:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value > current + 1:
                    raise ValueError("invalid mutation rate timestamp")
                if value > current - RATE_WINDOW_SECONDS:
                    timestamps.append(float(value))
        except FileNotFoundError:
            pass
        if len(timestamps) >= burst:
            raise RuntimeError("control mutation rate exceeded")
        timestamps.append(current)
        temp = state_path.with_name(f".{state_path.name}.tmp-{os.getpid()}")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, json.dumps({"timestamps": timestamps}, separators=(",", ":")).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, state_path)
    finally:
        os.close(lock_fd)


def _helper_capabilities(helper: Path, run: Runner, verify_files: bool = True) -> dict[str, Any]:
    if verify_files:
        _secure_file(helper, (0o755,), "reset helper")
    result = run([str(helper), "--capabilities"], 5.0)
    if result.returncode != 0 or len(result.stdout.encode()) > MAX_RESPONSE_BYTES:
        raise ValueError("helper capability probe failed")
    payload = _strict_json(result.stdout)
    if not isinstance(payload, dict) or set(payload) != {"protocol", "actions", "models", "helper"}:
        raise ValueError("helper capability shape mismatch")
    if type(payload.get("protocol")) is not int or payload.get("protocol") != HELPER_PROTOCOL:
        raise ValueError("helper protocol mismatch")
    if not isinstance(payload.get("actions"), list) or not all(isinstance(value, str) for value in payload["actions"]):
        raise ValueError("helper action shape mismatch")
    if not {"reset", "resume", "model"}.issubset(set(payload["actions"])):
        raise ValueError("helper action mismatch")
    if not isinstance(payload.get("models"), list) or not all(isinstance(value, str) for value in payload["models"]):
        raise ValueError("helper model shape mismatch")
    if not MODELS.issubset(set(payload["models"])):
        raise ValueError("helper model mismatch")
    return payload


def _exact_keys(request: dict[str, Any], expected: set[str]) -> None:
    if set(request) != expected:
        raise ValueError("invalid request shape")


def _validate_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not DIGITS_RE.fullmatch(value):
        raise ValueError(f"invalid {label}")
    parsed = int(value)
    if parsed < 1 or parsed > 2**53 - 1:
        raise ValueError(f"invalid {label}")
    return value


def _mutation_argv(request: dict[str, Any], helper: Path, config: Path) -> tuple[str, list[str]]:
    action = request.get("action")
    base = {"protocol", "action", "chat_id", "message_id"}
    if action == "reset":
        _exact_keys(request, base)
    elif action == "resume":
        _exact_keys(request, base | {"current_session_id", "session_id"})
        if not UUID_RE.fullmatch(str(request["current_session_id"])) or not UUID_RE.fullmatch(str(request["session_id"])):
            raise ValueError("invalid session identity")
    elif action == "model":
        _exact_keys(request, base | {"model"})
        if request["model"] not in MODELS:
            raise ValueError("invalid model")
    else:
        raise ValueError("invalid action")
    _validate_id(request["chat_id"], "chat ID")
    _validate_id(request["message_id"], "message ID")
    request_id = _request_id(action, request)
    unit = f"claude-session-reset{'-' + action if action != 'reset' else ''}-{request_id}"
    if not UNIT_RE.fullmatch(unit):
        raise ValueError("invalid unit")
    argv = [
        SYSTEMD_RUN, f"--unit={unit}", "--collect", "--no-block", str(helper),
        "--config", str(config), "--protocol", str(HELPER_PROTOCOL), "--action", action,
    ]
    if action == "resume":
        argv += ["--current-session-id", request["current_session_id"], "--session-id", request["session_id"]]
    if action == "model":
        argv += ["--model", request["model"]]
    argv += ["--chat-id", request["chat_id"], "--request-id", request_id]
    return unit, argv

def process_request(
    raw: bytes,
    peer_uid: int,
    *,
    config_path: Path = DEFAULT_CONFIG,
    helper: Path = DEFAULT_HELPER,
    run: Runner = _run,
    reserve: Callable[[Runner], None] | None = None,
    service_uid: int | None = None,
    verify_files: bool = True,
) -> dict[str, Any]:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request too large")
    request = _strict_json(raw.decode("utf-8"))
    protocol = request.get("protocol") if isinstance(request, dict) else None
    action = request.get("action") if isinstance(request, dict) else None
    if type(protocol) is not int or protocol != BROKER_PROTOCOL or not isinstance(action, str):
        raise ValueError("invalid broker protocol")
    expected_uid = _load_service_uid(config_path) if service_uid is None else service_uid
    if peer_uid != expected_uid:
        raise PermissionError("unauthorized peer")
    if request.get("action") == "capabilities":
        _exact_keys(request, {"protocol", "action"})
        return {"status": "ok", "capabilities": _helper_capabilities(helper, run, verify_files)}
    if verify_files:
        _secure_file(helper, (0o755,), "reset helper")
    unit, argv = _mutation_argv(request, helper, config_path)
    (reserve or _reserve_mutation)(run)
    result = run(argv, 10.0)
    if result.returncode != 0:
        raise RuntimeError("systemd rejected control job")
    return {"status": "scheduled", "unit": unit}


def _read_request(conn: socket.socket) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = conn.recv(min(4096, MAX_REQUEST_BYTES + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            raise ValueError("request too large")
        if b"\n" in chunk:
            break
    raw = b"".join(chunks)
    line, separator, tail = raw.partition(b"\n")
    if not separator or tail:
        raise ValueError("request must be one JSON line")
    return line


def serve_connected(
    conn: socket.socket,
    *,
    config_path: Path = DEFAULT_CONFIG,
    helper: Path = DEFAULT_HELPER,
    run: Runner = _run,
) -> None:
    conn.settimeout(SOCKET_TIMEOUT_SECONDS)
    credentials = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, peer_uid, _gid = struct.unpack("3i", credentials)
    try:
        response = process_request(_read_request(conn), peer_uid, config_path=config_path, helper=helper, run=run)
    except Exception:
        response = {"status": "failed", "error": "request rejected"}
    payload = json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = b'{"status":"failed","error":"response rejected"}\n'
    conn.sendall(payload)

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.parse_args(argv)
    try:
        conn = socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            serve_connected(conn)
        finally:
            conn.close()
        return 0
    except Exception:
        print("control broker failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
