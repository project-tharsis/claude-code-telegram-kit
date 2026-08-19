# Session Control MCP

An MCP front end for resetting, listing, and resuming sessions for one Telegram-connected Claude Code workspace.

## Tool

```text
schedule_session_reset(chat_id, message_id, confirmation="RESET SESSION")
list_sessions(chat_id)
resume_session(chat_id, index)
```

Reset and resume are destructive and should be listed under Claude Code `permissions.ask`; listing is explicitly allowed. An internal `bind_command` hook tool creates a short-lived current-turn capability only for exact `/sessions` and `/resume N` messages.

`/sessions` sends up to ten numbered titles and stores the UUID mapping in a private, atomic ten-minute snapshot. The model never receives or supplies a session UUID, transcript path, unit, service, helper path, or command. `/resume N` revalidates the selected transcript in both the unprivileged MCP and root helper before any restart.

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
CLAUDE_PROJECT_SESSIONS_DIR
```

Defaults are documented in `src/runtime.ts`. `CLAUDE_PROJECT_SESSIONS_DIR` has no default: listing returns no sessions until one fixed project directory is configured. The root helper reads a root-owned JSON configuration. See `examples/reset.json`.

At startup the control MCP runs the helper's read-only `--capabilities` command and requires Session Control Protocol v1 with both `reset` and `resume`. Version skew disables privileged actions while leaving listing and rendering available.

By default, the shared authority requires exactly one allowlisted chat. Multi-chat deployments must opt in with `TELEGRAM_ALLOW_MULTIPLE_CHATS=true` in both MCP server environments and `allow_multiple_chats: true` in the root config.

The helper stores root-owned idempotency receipts under `/var/lib/claude-code-telegram-kit/reset-requests/`, keyed by a hash of the inbound chat and message IDs.

## Installing the root helper

The versioned user-level deploy script intentionally does **not** install privileged files. Review an exact commit, copy the helper to a temporary root-reviewed path, verify its digest, then install it explicitly:

```bash
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_session_reset.py > /tmp/claude-code-session-reset
sha256sum /tmp/claude-code-session-reset
sudo install -o root -g root -m 0755 /tmp/claude-code-session-reset /usr/local/sbin/claude-code-session-reset
sudo sha256sum /usr/local/sbin/claude-code-session-reset
/usr/local/sbin/claude-code-session-reset --capabilities
```

Never run a privileged installer directly from a mutable checkout or user-writable `current` symlink.

## Local recovery

The local helper remains available when the bot or model is unavailable:

```bash
sudo claude-code-session-reset --config /etc/claude-code-telegram-kit/reset.json
```
