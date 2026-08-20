#!/usr/bin/env python3
"""Fail-closed UserPromptSubmit guard for Telegram session-control namespaces.

This command hook has no side effects. It runs in parallel with the deterministic MCP dispatcher
and blocks direct `/usage`, `/sessions`, `/model`, `/rename`, `/reset`, and `/resume` namespaces before the LLM. If the MCP is
restarting or times out, commands stay blocked rather than falling through to Claude.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

MAX_STDIN_BYTES = 4_500_000
MAX_ENVELOPE_TAG_CHARS = 1_024
CHANNEL_OPEN = "<channel"
CONTROL_NAMESPACE = re.compile(r"^/(?:usage|sessions|model|rename|reset|resume)(?=@|\s|$)")
MODEL_REPLY_CHOICE = re.compile(r"^[1-4] · (?:Opus|Sonnet|Haiku|Inherit)$")
ATTRIBUTE = re.compile(r'([a-z_][a-z0-9_]{0,31})="([^"<>]{0,256})"', re.IGNORECASE)
BLOCK = {
    "decision": "block",
    "reason": "Handled by deterministic Telegram session control.",
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "suppressOriginalPrompt": True,
    },
}


def _direct_telegram_body(prompt: Any) -> str | None:
    if not isinstance(prompt, str) or not prompt:
        return None
    trimmed = prompt.lstrip()
    if not trimmed.startswith(CHANNEL_OPEN) or trimmed.count(CHANNEL_OPEN) != 1:
        return None
    close = trimmed.find(">")
    if close < 0 or close > MAX_ENVELOPE_TAG_CHARS:
        return None
    tag = trimmed[len(CHANNEL_OPEN):close]
    if not tag or not tag[0].isspace():
        return None
    attributes = {match.group(1).lower(): match.group(2) for match in ATTRIBUTE.finditer(tag)}
    if attributes.get("source") not in {"telegram", "plugin:telegram:telegram"}:
        return None
    chat_id = attributes.get("chat_id", "")
    message_id = attributes.get("message_id", "")
    if not re.fullmatch(r"-?\d{1,20}", chat_id):
        return None
    if not re.fullmatch(r"\d{1,15}", message_id) or int(message_id) < 1:
        return None
    body = trimmed[close + 1:]
    closing = body.rfind("</channel>")
    if closing >= 0:
        body = body[:closing]
    return body.strip()


def should_block(payload: Any) -> bool:
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "UserPromptSubmit":
        return False
    body = _direct_telegram_body(payload.get("prompt"))
    return body is not None and (
        CONTROL_NAMESPACE.match(body) is not None
        or MODEL_REPLY_CHOICE.fullmatch(body) is not None
    )


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            return 0
        payload = json.loads(raw.decode("utf-8"))
        if should_block(payload):
            print(json.dumps(BLOCK, separators=(",", ":")))
    except Exception:
        # No side effects and no diagnostics enter Claude's context.
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
