#!/usr/bin/env python3
"""Versioned local installation and rollback for Claude Code Telegram Kit."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_PREFIX = Path.home() / ".local" / "share" / "claude-code-telegram-kit"
ACTIVATION_LOCK = Path("/run/lock/claude-code-telegram-kit/shared/deploy-activation.lock")


def _secure_prefix(prefix: Path) -> Path:
    expanded = prefix.expanduser()
    if expanded.is_symlink():
        raise ValueError("install prefix must not be a symlink")
    expanded.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = expanded.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("install prefix must be a real directory")
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
        raise ValueError("install prefix must be owned by the current user and not group/world writable")
    return expanded.resolve(strict=True)


def _lock_activation(*, expected_uid: int = 0) -> int | None:
    try:
        before = ACTIVATION_LOCK.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) != 0o660 or before.st_nlink != 1):
        raise ValueError("shared activation lock is not a secure root-owned mode-0660 file")
    fd = os.open(ACTIVATION_LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("shared activation lock changed during validation")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("runtime activation is active") from exc
        return fd
    except Exception:
        os.close(fd)
        raise


def _lock_prefix(prefix: Path) -> int:
    lock_path = prefix / ".deploy.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise ValueError("deploy lock ownership or mode is invalid")
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def validate_sha(value: str) -> str:
    normalized = value.strip().lower()
    if not SHA_RE.fullmatch(normalized):
        raise ValueError("ref must be an exact 40-character hexadecimal commit SHA")
    return normalized


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_symlink(link: Path, target: Path) -> None:
    temp = link.with_name(f".{link.name}.tmp.{uuid.uuid4().hex}")
    os.symlink(str(target), temp)
    os.replace(temp, link)
    _fsync_dir(link.parent)


def _release_sha(path: Path) -> str:
    return validate_sha(path.name)


def _verify_release(path: Path, expected_sha: str | None = None) -> str:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ValueError("release must be a real directory")
    sha = _release_sha(path)
    if expected_sha is not None and sha != expected_sha:
        raise ValueError("release directory does not match requested commit")

    receipt_path = path / ".installed.json"
    receipt_info = receipt_path.lstat()
    if not stat.S_ISREG(receipt_info.st_mode) or stat.S_ISLNK(receipt_info.st_mode) or receipt_info.st_nlink != 1:
        raise ValueError("release receipt must be a single regular file")
    fd = os.open(receipt_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if opened.st_dev != receipt_info.st_dev or opened.st_ino != receipt_info.st_ino:
            raise ValueError("release receipt changed during validation")
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as handle:
            data = json.load(handle)
    finally:
        os.close(fd)
    if not isinstance(data, dict) or data.get("commit") != sha:
        raise ValueError("release receipt commit does not match directory")
    return sha


def _resolved_link(link: Path, releases: Path) -> Path | None:
    if not link.exists() and not link.is_symlink():
        return None
    if not link.is_symlink():
        raise ValueError(f"{link.name} must be a symlink")
    target = link.resolve(strict=True)
    if target.parent != releases or not target.is_dir():
        raise ValueError(f"{link.name} must point to a direct release directory")
    _verify_release(target)
    return target


def activate_release(prefix: Path, target: Path) -> dict[str, str | None]:
    prefix = prefix.expanduser().resolve()
    releases = prefix / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target_input = target.expanduser()
    if target_input.is_symlink():
        raise ValueError("target release must not be a symlink")
    target = target_input.resolve(strict=True)
    if target.parent != releases.resolve() or not target.is_dir():
        raise ValueError("target must be inside the release directory")
    new_sha = _verify_release(target)

    current_link = prefix / "current"
    previous_link = prefix / "previous"
    old_current = _resolved_link(current_link, releases.resolve())
    old_previous = _resolved_link(previous_link, releases.resolve())

    if old_current == target:
        return {
            "current": new_sha,
            "previous": _release_sha(old_previous) if old_previous else None,
        }

    if old_current is not None:
        _atomic_symlink(previous_link, old_current)
    _atomic_symlink(current_link, target)
    return {
        "current": new_sha,
        "previous": _release_sha(old_current) if old_current else None,
    }


def rollback(prefix: Path) -> dict[str, str | None]:
    prefix = prefix.expanduser().resolve()
    releases = (prefix / "releases").resolve(strict=True)
    current = _resolved_link(prefix / "current", releases)
    previous = _resolved_link(prefix / "previous", releases)
    if current is None or previous is None:
        raise ValueError("rollback requires both current and previous releases")
    return activate_release(prefix, previous)


def _run(argv: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {Path(argv[0]).name}")
    return result.stdout.strip()


def _safe_extract(archive: Path, destination: Path) -> None:
    max_member_size = 100 * 1024 * 1024
    max_total_size = 512 * 1024 * 1024
    total_size = 0
    agent_guidance_link: Path | None = None
    with tarfile.open(archive, "r") as tar:
        for member in tar.getmembers():
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or not relative.parts or ".." in relative.parts:
                raise ValueError("release archive contains an unsafe path")
            if member.issym():
                if relative == PurePosixPath("CLAUDE.md") and member.linkname == "AGENTS.md":
                    agent_guidance_link = destination / "CLAUDE.md"
                    continue
                raise ValueError("release archive contains an unsupported symbolic link")
            if member.islnk() or not (member.isdir() or member.isfile()):
                raise ValueError("release archive may contain only regular files and directories")
            if member.size < 0 or member.size > max_member_size:
                raise ValueError("release archive member is too large")
            total_size += member.size
            if total_size > max_total_size:
                raise ValueError("release archive is too large")

            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            if member.isdir():
                target.mkdir(exist_ok=True, mode=0o755)
                continue

            source = tar.extractfile(member)
            if source is None:
                raise ValueError("release archive file has no content")
            mode = 0o755 if member.mode & 0o111 else 0o644
            fd = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                mode,
            )
            try:
                with os.fdopen(fd, "wb", closefd=False) as out:
                    shutil.copyfileobj(source, out)
                    out.flush()
                    os.fsync(out.fileno())
            finally:
                os.close(fd)
    if agent_guidance_link is not None:
        authority = destination / "AGENTS.md"
        info = authority.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError("AGENTS.md must be a regular file")
        os.symlink("AGENTS.md", agent_guidance_link)
        _fsync_dir(destination)


def install_release(repo: Path, sha: str, prefix: Path, bun: str) -> dict[str, str | None]:
    repo = repo.expanduser().resolve(strict=True)
    if not (repo / ".git").exists():
        raise ValueError("repo must be a Git working tree")
    sha = validate_sha(sha)
    resolved = _run(["git", "-C", str(repo), "rev-parse", f"{sha}^{{commit}}"])
    if resolved.lower() != sha:
        raise ValueError("requested SHA does not resolve exactly")

    prefix = prefix.expanduser().resolve()
    releases = prefix / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target = releases / sha
    if not target.exists():
        temp = releases / f".tmp.{sha}.{uuid.uuid4().hex}"
        archive = releases / f".tmp.{sha}.{uuid.uuid4().hex}.tar"
        try:
            temp.mkdir(mode=0o755)
            _run(["git", "-C", str(repo), "archive", "--format=tar", "--output", str(archive), sha])
            _safe_extract(archive, temp)
            _run([bun, "install", "--frozen-lockfile", "--production"], cwd=temp)
            (temp / ".installed.json").write_text(
                json.dumps({"commit": sha}, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            os.replace(temp, target)
            _fsync_dir(releases)
        finally:
            archive.unlink(missing_ok=True)
            if temp.exists():
                shutil.rmtree(temp)
    else:
        _verify_release(target, sha)

    activation: dict[str, Any] = activate_release(prefix, target)
    activation["commit"] = sha
    activation["activation_required"] = True
    return activation


def status(prefix: Path) -> dict[str, str | None]:
    prefix = prefix.expanduser().resolve()
    releases = prefix / "releases"
    if not releases.exists():
        return {"current": None, "previous": None}
    releases = releases.resolve()
    current = _resolved_link(prefix / "current", releases)
    previous = _resolved_link(prefix / "previous", releases)
    return {
        "current": _release_sha(current) if current else None,
        "previous": _release_sha(previous) if previous else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("install")
    install.add_argument("--repo", type=Path, required=True)
    install.add_argument("--ref", required=True)
    install.add_argument("--bun", default=os.environ.get("BUN_BIN", "bun"))

    sub.add_parser("rollback")
    sub.add_parser("status")

    args = parser.parse_args()
    prefix = _secure_prefix(args.prefix)
    activation_fd = _lock_activation()
    lock_fd = -1
    try:
        lock_fd = _lock_prefix(prefix)
        receipt: dict[str, Any]
        if args.command == "install":
            receipt = install_release(args.repo, args.ref, prefix, args.bun)
        elif args.command == "rollback":
            receipt = rollback(prefix)
            receipt["activation_required"] = True
        else:
            receipt = status(prefix)
    finally:
        if lock_fd >= 0:
            os.close(lock_fd)
        if activation_fd is not None:
            os.close(activation_fd)
    print(json.dumps(receipt, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
