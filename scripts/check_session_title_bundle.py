#!/usr/bin/env python3
"""Rebuild every checked-in isolated worker bundle with the pinned project Bun and compare bytes.

Covers the session title worker and the Memory Harness isolated reviewer worker: both are
immutable one-shot Bun bundles installed as root-owned, non-writable root assets and must
byte-for-byte match their checked-in source.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUN = os.environ.get("BUN_BIN", str(Path.home() / ".bun/bin/bun"))
WORKERS = (
    (ROOT / "packages/session-control-mcp/src/session-title-worker.ts", ROOT / "packages/session-control-mcp/dist/session-title-worker.js"),
    (ROOT / "packages/session-control-mcp/src/memory-review-worker.ts", ROOT / "packages/session-control-mcp/dist/memory-review-worker.js"),
)


def main() -> int:
    if not Path(BUN).is_file():
        raise SystemExit(f"pinned Bun not found: {BUN}")
    with tempfile.TemporaryDirectory() as td:
        for source, bundle in WORKERS:
            rebuilt = Path(td) / bundle.name
            subprocess.run(
                [BUN, "build", str(source), "--target=bun", f"--outfile={rebuilt}"],
                cwd=ROOT,
                check=True,
            )
            expected = bundle.read_bytes()
            actual = rebuilt.read_bytes()
            if actual != expected:
                raise SystemExit(f"checked-in worker bundle drifted: {bundle}")
            if not 1 <= len(expected) <= 256 * 1024:
                raise SystemExit(f"unexpected worker bundle size: {bundle} ({len(expected)} bytes)")
            print(f"{bundle.relative_to(ROOT)} verified ({len(expected)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
