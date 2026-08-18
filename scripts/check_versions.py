#!/usr/bin/env python3
"""Require one SemVer across the source-only monorepo."""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
paths = [ROOT / "package.json", *sorted((ROOT / "packages").glob("*/package.json"))]
versions = {}
for path in paths:
    data = json.loads(path.read_text(encoding="utf-8"))
    version = data.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        print(f"invalid version: {path.relative_to(ROOT)}", file=sys.stderr)
        raise SystemExit(1)
    versions[str(path.relative_to(ROOT))] = version
if len(set(versions.values())) != 1:
    for path, version in versions.items():
        print(f"{path}: {version}", file=sys.stderr)
    raise SystemExit(1)
print(f"version-check: {next(iter(versions.values()))}")
