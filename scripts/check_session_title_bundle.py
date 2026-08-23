#!/usr/bin/env python3
"""Rebuild the checked-in title worker with the pinned project Bun and compare bytes."""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "packages/session-control-mcp/src/session-title-worker.ts"
BUNDLE = ROOT / "packages/session-control-mcp/dist/session-title-worker.js"
BUN = os.environ.get("BUN_BIN", str(Path.home() / ".bun/bin/bun"))


def main() -> int:
    if not Path(BUN).is_file():
        raise SystemExit(f"pinned Bun not found: {BUN}")
    with tempfile.TemporaryDirectory() as td:
        rebuilt = Path(td) / BUNDLE.name
        subprocess.run(
            [BUN, "build", str(SOURCE), "--target=bun", f"--outfile={rebuilt}"],
            cwd=ROOT,
            check=True,
        )
        expected = BUNDLE.read_bytes()
        actual = rebuilt.read_bytes()
    if actual != expected:
        raise SystemExit(f"checked-in title worker bundle drifted: {BUNDLE}")
    if not 1 <= len(expected) <= 256 * 1024:
        raise SystemExit(f"unexpected title worker bundle size: {len(expected)}")
    print(f"title worker bundle verified ({len(expected)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
