#!/usr/bin/env python3
"""Install or roll back root-owned Telegram kit assets from one exact Git commit."""

from __future__ import annotations

import argparse
import grp
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
    preserve_existing: bool = False


ASSETS = (
    Asset("packages/session-control-mcp/scripts/claude_code_session_reset.py", "/usr/local/sbin/claude-code-session-reset", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_control_broker.py", "/usr/local/sbin/claude-code-control-broker", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_session_receipt.py", "/usr/local/sbin/claude-session-start-receipt", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_control_guard.py", "/usr/local/sbin/claude-control-command-guard", 0o755),
    Asset("packages/session-control-mcp/scripts/claude_code_usage_snapshot.py", "/usr/local/sbin/claude-usage-snapshot", 0o755),
    Asset("packages/session-control-mcp/dist/session-title-worker.js", "/usr/local/libexec/claude-code-telegram-kit/session-title-worker.js", 0o444),
    Asset("packages/session-control-mcp/dist/memory-review-worker.js", "/usr/local/libexec/claude-code-telegram-kit/memory-review-worker.js", 0o444),
    Asset("scripts/runtime_activate.py", "/usr/local/sbin/claude-runtime-activate", 0o755),
    Asset("scripts/check_claude_compatibility.py", "/usr/local/sbin/claude-check-compatibility", 0o755),
    Asset("examples/claude-runtime-activation.json", "/etc/claude-code-telegram-kit/activation.json", 0o600, True, True),
    Asset("examples/claude-telegram-activation.conf", "/etc/systemd/system/claude-telegram.service.d/30-runtime-activation.conf", 0o644),
    Asset("examples/claude-code-telegram-kit-tmpfiles.conf", "/usr/lib/tmpfiles.d/claude-code-telegram-kit.conf", 0o644, True),
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


def _render(asset: Asset, data: bytes, service_user: str, service_group: str) -> bytes:
    if not asset.render_user:
        return data
    rendered = data.replace(b"SERVICE_GROUP", service_group.encode("ascii"))
    rendered = rendered.replace(b"USER", service_user.encode("ascii"))
    if b"USER" in rendered or b"SERVICE_GROUP" in rendered:
        raise ValueError("unresolved service account placeholder")
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
    backups = state_root / "backups"
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    backups_fd = os.open(backups, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(backups_fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_gid != owner_gid):
            raise PermissionError("root asset backup directory is not secure")
        if stat.S_IMODE(info.st_mode) != 0o700:
            os.fchmod(backups_fd, 0o700)
            os.fsync(backups_fd)
        hardened = os.fstat(backups_fd)
        if (hardened.st_dev != info.st_dev or hardened.st_ino != info.st_ino
                or hardened.st_uid != owner_uid or hardened.st_gid != owner_gid
                or stat.S_IMODE(hardened.st_mode) != 0o700):
            raise PermissionError("root asset backup directory hardening failed")
        for _attempt in range(8):
            backup_name = f"{int(time.time())}-{os.getpid()}-{os.urandom(6).hex()}"
            try:
                os.mkdir(backup_name, mode=0o700, dir_fd=backups_fd)
                backup = backups / backup_name
                break
            except FileExistsError:
                continue
        else:
            raise FileExistsError("could not allocate a unique root asset backup")
    finally:
        os.close(backups_fd)
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
    previous_manifest = state_root / "installed.json"
    backup_record = {"assets": records, "previous_manifest": previous_manifest.exists()}
    if previous_manifest.exists():
        info = previous_manifest.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError("unsafe installed manifest")
        _atomic_write(backup / "previous-installed.json", previous_manifest.read_bytes(), 0o600, owner_uid, owner_gid)
    _atomic_write(backup / "manifest.json", json.dumps(backup_record, separators=(",", ":")).encode(), 0o600, owner_uid, owner_gid)
    return backup


def _verify_destination(path: Path, expected: bytes, mode: int, owner_uid: int = 0, owner_gid: int = 0) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != owner_uid or info.st_gid != owner_gid:
        raise ValueError(f"unsafe installed asset: {path}")
    if stat.S_IMODE(info.st_mode) != mode or _sha256(path.read_bytes()) != _sha256(expected):
        raise ValueError(f"installed asset mismatch: {path}")


def _read_preserved_root_asset(
    path: Path,
    mode: int,
    owner_uid: int = 0,
    owner_gid: int = 0,
    max_bytes: int = 64 * 1024,
) -> bytes:
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
            or before.st_uid != owner_uid or before.st_gid != owner_gid
            or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != mode
            or before.st_size < 2 or before.st_size > max_bytes):
        raise PermissionError(f"unsafe preserved root asset: {path}")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev != before.st_dev or opened.st_ino != before.st_ino
                or opened.st_uid != owner_uid or opened.st_gid != owner_gid
                or opened.st_nlink != 1 or stat.S_IMODE(opened.st_mode) != mode
                or opened.st_size != before.st_size):
            raise PermissionError(f"preserved root asset changed during read: {path}")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(fd, remaining)
            if not chunk:
                raise OSError(f"short preserved root asset read: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(fd)
        if (after.st_dev != opened.st_dev or after.st_ino != opened.st_ino
                or after.st_size != opened.st_size or after.st_mtime_ns != opened.st_mtime_ns):
            raise PermissionError(f"preserved root asset changed during read: {path}")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _verify_runtime(path: Path, service_uid: int) -> tuple[str, str]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != service_uid or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o755):
            raise ValueError("service-user Bun runtime is not a secure 0755 regular file")
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        return str(path), digest.hexdigest()
    finally:
        os.close(fd)

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
    installed_path = backup.parent.parent / "installed.json"
    if manifest.get("previous_manifest"):
        _atomic_write(installed_path, (backup / "previous-installed.json").read_bytes(), 0o600, owner_uid, owner_gid)
    elif installed_path.exists():
        installed_path.unlink()


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
    service_group = grp.getgrgid(account.pw_gid).gr_name
    service_group.encode("ascii")
    bun_path, bun_sha256 = _verify_runtime(Path(account.pw_dir) / ".bun/bin/bun", account.pw_uid)
    _secure_state_root(state_root, owner_uid)
    rendered = [
        (asset, _render(asset, _git_show(repo, commit, asset.source), service_user, service_group))
        for asset in ASSETS
    ]
    destinations = [_destination(asset, root_prefix) for asset, _data in rendered]
    prepared: list[tuple[Asset, bytes, Path, bool]] = []
    for (asset, rendered_data), destination in zip(rendered, destinations):
        preserved = False
        data = rendered_data
        if asset.preserve_existing:
            try:
                data = _read_preserved_root_asset(destination, asset.mode, owner_uid, owner_gid)
                preserved = True
            except FileNotFoundError:
                pass
        prepared.append((asset, data, destination, preserved))
    backup = _backup(destinations, state_root, owner_uid, owner_gid)
    try:
        for asset, data, destination, preserved in prepared:
            if not preserved:
                _atomic_write(destination, data, asset.mode, owner_uid, owner_gid)
            _verify_destination(destination, data, asset.mode, owner_uid, owner_gid)
        manifest = {
            "commit": commit,
            "service_user": service_user,
            "bun": {"path": bun_path, "sha256": bun_sha256, "mode": "0755"},
            "backup": str(backup),
            "assets": [
                {"destination": str(destination), "sha256": _sha256(data), "mode": oct(asset.mode)}
                for asset, data, destination, _preserved in prepared
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
