#!/usr/bin/env python3
"""Require one SemVer across the source-only monorepo."""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
paths = [ROOT / "package.json", *sorted((ROOT / "packages").glob("*/package.json"))]
server_paths = sorted((ROOT / "packages").glob("*/src/server.ts"))
server_version = re.compile(
    r'new Server\(\s*\{\s*name:\s*"[^"]+",\s*version:\s*"([^"]+)"\s*\}',
    re.MULTILINE,
)
versions = {}
for path in paths:
    data = json.loads(path.read_text(encoding="utf-8"))
    version = data.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        print(f"invalid version: {path.relative_to(ROOT)}", file=sys.stderr)
        raise SystemExit(1)
    versions[str(path.relative_to(ROOT))] = version
for path in server_paths:
    match = server_version.search(path.read_text(encoding="utf-8"))
    if match is None or not SEMVER.fullmatch(match.group(1)):
        print(f"missing or invalid MCP server version: {path.relative_to(ROOT)}", file=sys.stderr)
        raise SystemExit(1)
    versions[str(path.relative_to(ROOT))] = match.group(1)
lock_path = ROOT / "bun.lock"
lock_versions = re.findall(r'^\s+"version": "([^"]+)",$', lock_path.read_text(encoding="utf-8"), re.MULTILINE)
if len(lock_versions) != len(paths) - 1 or any(not SEMVER.fullmatch(version) for version in lock_versions):
    print("missing or invalid workspace versions: bun.lock", file=sys.stderr)
    raise SystemExit(1)
for index, version in enumerate(lock_versions, start=1):
    versions[f"bun.lock workspace {index}"] = version
if len(set(versions.values())) != 1:
    for path, version in versions.items():
        print(f"{path}: {version}", file=sys.stderr)
    raise SystemExit(1)
version = next(iter(versions.values()))
changelog_path = ROOT / "CHANGELOG.md"
release_heading = re.compile(
    rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$",
    re.MULTILINE,
)
if not release_heading.search(changelog_path.read_text(encoding="utf-8")):
    print(f"missing dated {version} release heading: CHANGELOG.md", file=sys.stderr)
    raise SystemExit(1)
print(f"version-check: {version}")
