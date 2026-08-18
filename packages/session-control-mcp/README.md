# Session Control MCP

An approval-gated MCP front end for resetting a Telegram-connected Claude Code service to a fresh session.

## Tool

```text
schedule_session_reset(chat_id, confirmation="RESET SESSION")
```

The tool is marked destructive and should be listed under Claude Code `permissions.ask`.

## Control-plane order

1. Validate official Channel state and allowlist.
2. Send a Telegram acceptance message and require a message receipt.
3. Submit a fixed, no-shell `systemd-run --no-block` command.
4. Let the root-owned reset helper create and verify the fresh session.
5. Send completion or failure directly from the helper.

The MCP does not accept command, path, unit, service, or helper arguments from the model.

## Runtime configuration

The MCP reads:

```text
CLAUDE_SESSION_RESET_HELPER
CLAUDE_SESSION_RESET_CONFIG
CLAUDE_SESSION_RESET_UNIT_PREFIX
```

Defaults are documented in `src/runtime.ts`. The reset helper reads a root-owned JSON configuration. See `examples/reset.json`.

## Local recovery

The local helper remains available when the bot or model is unavailable:

```bash
sudo claude-code-session-reset --config /etc/claude-code-telegram-kit/reset.json
```
