#!/usr/bin/env python3
"""Fail when private deployment identity leaks into the public source tree."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", "__pycache__"}
FORBIDDEN = {
    "concrete home path": re.compile(
        r"/home/(?!(?:USER|user|example)(?:/|$))[A-Za-z0-9_.-]+(?=/|$)"
    ),
    "concrete bot username": re.compile(r"@[A-Za-z0-9_]{5,}_bot\b", re.IGNORECASE),
    "long Telegram identifier": re.compile(
        r"(?:chat_id|allowFrom|allowedChatIds)[^\n]{0,80}\d{10,}"
    ),
    "static Telegram token shape": re.compile(
        r"TELEGRAM_BOT_TOKEN\s*=\s*\d{6,}:[A-Za-z0-9_-]{20,}"
    ),
}


def main() -> int:
    failures: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name == "bun.lock":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        relative = path.relative_to(ROOT)
        if relative == Path("scripts/check_public_tree.py"):
            continue
        for label, pattern in FORBIDDEN.items():
            if pattern.search(text):
                failures.append(f"{relative}: {label}")
    if failures:
        for failure in sorted(failures):
            print(failure, file=sys.stderr)
        return 1
    print("public-tree-scan: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
