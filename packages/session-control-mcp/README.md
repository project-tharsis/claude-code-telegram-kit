# Session Control MCP

An approval-gated MCP front end for resetting a Telegram-connected Claude Code service to a fresh session.

## Tool

```text
schedule_session_reset(chat_id, message_id, confirmation="RESET SESSION")
```

The tool is marked destructive and should be listed under Claude Code `permissions.ask`.

## Control-plane order

1. Validate official Channel state and allowlist.
2. Send a Telegram acceptance message quoting the triggering `/reset` and require a message receipt.
3. Best-effort replace the triggering message's `👀` with `👍`; reaction failure never blocks reset.
4. Submit a fixed, no-shell `systemd-run --no-block` command.
5. Let the root-owned reset helper create and verify the fresh session.
6. Send completion or failure independently from the helper.

The MCP does not accept command, path, unit, service, or helper arguments from the model.

## Runtime configuration

The MCP reads:

```text
CLAUDE_SESSION_RESET_HELPER
CLAUDE_SESSION_RESET_CONFIG
CLAUDE_SESSION_RESET_UNIT_PREFIX
```

Defaults are documented in `src/runtime.ts`. The reset helper reads a root-owned JSON configuration. See `examples/reset.json`.

By default, the shared authority requires exactly one allowlisted chat. Multi-chat deployments must opt in with `TELEGRAM_ALLOW_MULTIPLE_CHATS=true` in both MCP server environments and `allow_multiple_chats: true` in the root config.

The helper stores root-owned idempotency receipts under `/var/lib/claude-code-telegram-kit/reset-requests/`, keyed by a hash of the inbound chat and message IDs.

## Installing the root helper

The versioned user-level deploy script intentionally does **not** install privileged files. Review an exact commit, copy the helper to a temporary root-reviewed path, verify its digest, then install it explicitly:

```bash
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_session_reset.py > /tmp/claude-code-session-reset
sha256sum /tmp/claude-code-session-reset
sudo install -o root -g root -m 0755 /tmp/claude-code-session-reset /usr/local/sbin/claude-code-session-reset
sudo sha256sum /usr/local/sbin/claude-code-session-reset
```

Never run a privileged installer directly from a mutable checkout or user-writable `current` symlink.

## Local recovery

The local helper remains available when the bot or model is unavailable:

```bash
sudo claude-code-session-reset --config /etc/claude-code-telegram-kit/reset.json
```
