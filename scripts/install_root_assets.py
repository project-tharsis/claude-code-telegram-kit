#!/usr/bin/env python3
"""Install or roll back root-owned Telegram kit assets from one exact Git commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

SELF_PATH = "scripts/install_root_assets.py"
STATE_ROOT = Path("/var/lib/claude-code-telegram-kit/root-assets")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class Asset:
    source: str
    destination: str
    mode: int
    render_user: bool = False


ASSETS = (
    Asset("packages/session-control-mcp/scripts/claude_code_session_reset.py", "/usr/local/sbin/claude-code-session-reset", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_control_broker.py", "/usr/local/sbin/claude-code-control-broker", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_session_receipt.py", "/usr/local/sbin/claude-session-start-receipt", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_control_guard.py", "/usr/local/sbin/claude-control-command-guard", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_usage_snapshot.py", "/usr/local/sbin/claude-usage-snapshot", 0o755),
    Asset("examples/claude-code-control.socket", "/etc/systemd/system/claude-code-control.socket", 0o644, True),
    Asset("examples/claude-code-control@.service", "/etc/systemd/system/claude-code-control@.service", 0o644),
    Asset("examples/claude-telegram-hardening.conf", "/etc/systemd/system/claude-telegram.service.d/20-control-broker.conf", 0o644),
)


def _git_show(repo: Path, commit: str, source: str) -> bytes:
    result = subprocess.run(
        ["/usr/bin/git", "-c", f"safe.directory={repo}", "-C", str(repo), "show", f"{commit}:{source}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"missing root asset: {source}")
    return result.stdout


def _render(asset: Asset, data: bytes, service_user: str) -> bytes:
    if not asset.render_user:
        return data
    rendered = data.replace(b"USER", service_user.encode("ascii"))
    if b"USER" in rendered:
        raise ValueError("unresolved service user placeholder")
    return rendered


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def _atomic_write(path: Path, data: bytes, mode: int, owner_uid: int = 0, owner_gid: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    temp = path.parent / f".{path.name}.tmp-{os.getpid()}"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.fchmod(fd, mode)
        os.fchown(fd, owner_uid, owner_gid)
    finally:
        os.close(fd)
    os.replace(temp, path)
    dir_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _secure_state_root(state_root: Path, owner_uid: int = 0) -> None:
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = state_root.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise PermissionError("root asset state is not secure")


def _backup(destinations: list[Path], state_root: Path, owner_uid: int = 0, owner_gid: int = 0) -> Path:
    backup = state_root / "backups" / f"{int(time.time())}-{os.getpid()}"
    backup.mkdir(parents=True, mode=0o700)
    records = []
    for index, destination in enumerate(destinations):
        record = {"destination": str(destination), "exists": destination.exists()}
        if destination.exists():
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError(f"unsafe destination: {destination}")
            name = f"{index}.bin"
            data = destination.read_bytes()
            _atomic_write(backup / name, data, 0o600, owner_uid, owner_gid)
            record.update({"file": name, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid})
        records.append(record)
    _atomic_write(backup / "manifest.json", json.dumps({"assets": records}, separators=(",", ":")).encode(), 0o600, owner_uid, owner_gid)
    return backup


def _verify_destination(path: Path, expected: bytes, mode: int, owner_uid: int = 0, owner_gid: int = 0) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or info.st_gid != owner_gid:
        raise ValueError(f"unsafe installed asset: {path}")
    if stat.S_IMODE(info.st_mode) != mode or _sha256(path.read_bytes()) != _sha256(expected):
        raise ValueError(f"installed asset mismatch: {path}")

def _destination(asset: Asset, root_prefix: Path) -> Path:
    return root_prefix / asset.destination.lstrip("/")


def _restore_backup(backup: Path, owner_uid: int = 0, owner_gid: int = 0) -> None:
    manifest = json.loads((backup / "manifest.json").read_text())
    for record in manifest["assets"]:
        destination = Path(record["destination"])
        if record["exists"]:
            data = (backup / record["file"]).read_bytes()
            _atomic_write(destination, data, int(record["mode"]), int(record["uid"]), int(record["gid"]))
        elif destination.exists():
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError(f"unsafe rollback destination: {destination}")
            destination.unlink()


def install_release(
    repo: Path,
    commit: str,
    service_user: str,
    *,
    state_root: Path = STATE_ROOT,
    root_prefix: Path = Path("/"),
    owner_uid: int = 0,
    owner_gid: int = 0,
    verify_self: bool = True,
) -> dict[str, object]:
    if not SHA_RE.fullmatch(commit):
        raise ValueError("commit must be an exact lowercase SHA")
    repo = repo.resolve()
    if verify_self and _git_show(repo, commit, SELF_PATH) != Path(__file__).read_bytes():
        raise RuntimeError("installer does not match the requested commit")
    service_user.encode("ascii")
    account = pwd.getpwnam(service_user)
    if account.pw_uid == 0:
        raise ValueError("service user must be unprivileged")
    _secure_state_root(state_root, owner_uid)
    rendered = [(asset, _render(asset, _git_show(repo, commit, asset.source), service_user)) for asset in ASSETS]
    destinations = [_destination(asset, root_prefix) for asset, _data in rendered]
    backup = _backup(destinations, state_root, owner_uid, owner_gid)
    try:
        for (asset, data), destination in zip(rendered, destinations):
            _atomic_write(destination, data, asset.mode, owner_uid, owner_gid)
            _verify_destination(destination, data, asset.mode, owner_uid, owner_gid)
        manifest = {
            "commit": commit,
            "service_user": service_user,
            "backup": str(backup),
            "assets": [
                {"destination": str(destination), "sha256": _sha256(data), "mode": oct(asset.mode)}
                for (asset, data), destination in zip(rendered, destinations)
            ],
        }
        _atomic_write(state_root / "installed.json", json.dumps(manifest, separators=(",", ":")).encode(), 0o600, owner_uid, owner_gid)
        return manifest
    except Exception:
        _restore_backup(backup, owner_uid, owner_gid)
        raise


def rollback_release(
    *,
    state_root: Path = STATE_ROOT,
    owner_uid: int = 0,
    owner_gid: int = 0,
) -> dict[str, object]:
    _secure_state_root(state_root, owner_uid)
    installed_path = state_root / "installed.json"
    info = installed_path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or stat.S_IMODE(info.st_mode) != 0o600:
        raise PermissionError("installed root manifest is not secure")
    installed = json.loads(installed_path.read_text())
    backup = Path(installed["backup"])
    if state_root not in backup.parents:
        raise ValueError("backup path escaped root asset state")
    _restore_backup(backup, owner_uid, owner_gid)
    installed_path.unlink()
    return {"rolled_back": installed.get("commit"), "backup": str(backup)}

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("install", "rollback"))
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--commit")
    parser.add_argument("--service-user")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        parser.error("root asset installation requires root")
    try:
        if args.action == "install":
            if args.repo is None or args.commit is None or args.service_user is None:
                parser.error("install requires --repo, --commit, and --service-user")
            result = install_release(args.repo, args.commit, args.service_user)
        else:
            result = rollback_release()
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
