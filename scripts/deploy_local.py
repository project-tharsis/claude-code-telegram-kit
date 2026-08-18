#!/usr/bin/env python3
"""Versioned local installation and rollback for Claude Code Telegram Kit."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import Any

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_PREFIX = Path.home() / ".local" / "share" / "claude-code-telegram-kit"
DEFAULT_HELPER = Path("/usr/local/sbin/claude-code-session-reset")


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


def _resolved_link(link: Path, releases: Path) -> Path | None:
    if not link.exists() and not link.is_symlink():
        return None
    if not link.is_symlink():
        raise ValueError(f"{link.name} must be a symlink")
    target = link.resolve(strict=True)
    if target.parent != releases or not target.is_dir():
        raise ValueError(f"{link.name} must point to a direct release directory")
    _release_sha(target)
    return target


def activate_release(prefix: Path, target: Path) -> dict[str, str | None]:
    prefix = prefix.expanduser().resolve()
    releases = prefix / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target = target.resolve(strict=True)
    if target.parent != releases.resolve() or not target.is_dir():
        raise ValueError("target must be inside the release directory")
    new_sha = _release_sha(target)

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
    with tarfile.open(archive, "r") as tar:
        destination_real = destination.resolve()
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise ValueError("release archive must not contain links")
            target = (destination / member.name).resolve()
            if target != destination_real and destination_real not in target.parents:
                raise ValueError("release archive contains an unsafe path")
        tar.extractall(destination, filter="data")


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
    elif not (target / ".installed.json").is_file():
        raise ValueError("existing release is missing its installation receipt")

    return activate_release(prefix, target)


def install_helper(prefix: Path, destination: Path) -> dict[str, str]:
    if os.geteuid() != 0:
        raise PermissionError("install-helper must run as root")
    prefix = prefix.expanduser().resolve(strict=True)
    releases = (prefix / "releases").resolve(strict=True)
    current = _resolved_link(prefix / "current", releases)
    if current is None:
        raise ValueError("no current release")
    source = current / "packages" / "session-control-mcp" / "scripts" / "claude_code_session_reset.py"
    info = source.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("reset helper source is not a regular file")
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(f".{destination.name}.tmp.{uuid.uuid4().hex}")
    with source.open("rb") as source_fh, open(temp, "xb") as target_fh:
        shutil.copyfileobj(source_fh, target_fh)
        target_fh.flush()
        os.fsync(target_fh.fileno())
    os.chown(temp, 0, 0)
    os.chmod(temp, 0o755)
    os.replace(temp, destination)
    _fsync_dir(destination.parent)
    return {"source_commit": _release_sha(current), "helper": str(destination)}


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

    helper = sub.add_parser("install-helper")
    helper.add_argument("--destination", type=Path, default=DEFAULT_HELPER)

    args = parser.parse_args()
    if args.command == "install":
        receipt: dict[str, Any] = install_release(args.repo, args.ref, args.prefix, args.bun)
    elif args.command == "rollback":
        receipt = rollback(args.prefix)
    elif args.command == "install-helper":
        receipt = install_helper(args.prefix, args.destination)
    else:
        receipt = status(args.prefix)
    print(json.dumps(receipt, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
