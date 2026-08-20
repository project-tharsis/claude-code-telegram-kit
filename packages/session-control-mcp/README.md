# Session Control MCP

An MCP front end for resetting, listing, and resuming sessions for one Telegram-connected Claude Code workspace.

## Hook tool

```text
dispatch_command(session_id, prompt_id, prompt, hook_event_name="UserPromptSubmit")
```

`dispatch_command` is wired as a denied-to-the-model `UserPromptSubmit` `mcp_tool` hook. It deterministically parses direct Telegram control commands before the LLM: ordinary messages pass through, while `/usage`, `/sessions`, `/reset`, `/resume N`, and confirmation commands are handled and returned with `decision: block`.

An independent, side-effect-free command hook (`claude-control-command-guard`) returns the same block decision for control namespaces. It does not depend on MCP readiness, so a timeout or MCP restart cannot leak a control command into the LLM. Only `dispatch_command` performs listing, challenge delivery, or scheduling.

Legacy public reset/list/resume tools remain exposed only as fail-closed compatibility surfaces and should all be listed under `permissions.deny`. Exact control commands never rely on model tool selection.

`/usage` reads a private service-user-owned cache written from Claude's documented `statusLine.rate_limits`; it starts no extra Claude process and calls neither the LLM nor the OAuth usage endpoint. Delivery uses Telegram-safe HTML with bold percentages, reset timestamps, and a compact ten-cell micro-bar. `/sessions` sends up to ten numbered titles and stores the UUID mapping in a private, atomic ten-minute snapshot. `/reset` and `/resume N` issue an action-bound, latest-per-chat, single-use 60-second confirmation code. The confirmation command carries no index or UUID; resume resolves the privately stored index through the snapshot. The model never receives or supplies a confirmation code, session index, session UUID, transcript path, unit, service, helper path, or command.

## Control-plane order

1. The official Channel remains the only Telegram poller and invokes the UserPromptSubmit dispatcher hook.
2. Validate the exact direct envelope, live allowlist, and control-command grammar.
3. `/reset` or `/resume N` sends a quoted 60-second confirmation challenge and performs no mutation.
4. The exact action-bound confirmation consumes the challenge once; replay, wrong action, wrong code, and expiry fail closed.
5. Send a quoted acceptance message, then submit a fixed, no-shell `systemd-run --no-block` command.
6. Let the root-owned helper verify the exact runtime and send completion or failure independently.

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

At startup the control MCP runs the helper's read-only `--capabilities` command and requires Session Control Protocol v3 with both `reset` and `resume`. Version skew disables privileged actions while leaving listing and rendering available. Protocol v3 binds every resume to both the current session and the selected target, binds root-owned receipts to the action payload, and verifies a fresh reset by a secure SessionStart receipt plus exact process and worker health instead of any transcript content or LLM response.

By default, the shared authority requires exactly one allowlisted chat. Multi-chat deployments must opt in with `TELEGRAM_ALLOW_MULTIPLE_CHATS=true` in both MCP server environments and `allow_multiple_chats: true` in the root config.

The helper stores root-owned idempotency receipts under `/var/lib/claude-code-telegram-kit/reset-requests/`, keyed by a hash of the inbound chat and message IDs.

## Installing the root helper

The versioned user-level deploy script intentionally does **not** install privileged files. Review an exact commit, copy the helper to a temporary root-reviewed path, verify its digest, then install it explicitly:

```bash
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_session_reset.py > /tmp/claude-code-session-reset
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_session_receipt.py > /tmp/claude-session-start-receipt
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_control_guard.py > /tmp/claude-control-command-guard
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_usage_snapshot.py > /tmp/claude-usage-snapshot
sha256sum /tmp/claude-code-session-reset
sha256sum /tmp/claude-session-start-receipt /tmp/claude-control-command-guard
sha256sum /tmp/claude-usage-snapshot
sudo install -o root -g root -m 0755 /tmp/claude-code-session-reset /usr/local/sbin/claude-code-session-reset
sudo install -o root -g root -m 0755 /tmp/claude-session-start-receipt /usr/local/sbin/claude-session-start-receipt
sudo install -o root -g root -m 0755 /tmp/claude-control-command-guard /usr/local/sbin/claude-control-command-guard
sudo install -o root -g root -m 0755 /tmp/claude-usage-snapshot /usr/local/sbin/claude-usage-snapshot
sudo sha256sum /usr/local/sbin/claude-code-session-reset
sudo sha256sum /usr/local/sbin/claude-session-start-receipt /usr/local/sbin/claude-control-command-guard
sudo sha256sum /usr/local/sbin/claude-usage-snapshot
sudo install -d -o USER -g USER -m 0700 /home/USER/.local/state/claude-code-telegram-kit
/usr/local/sbin/claude-code-session-reset --capabilities
```

Never run a privileged installer directly from a mutable checkout or user-writable `current` symlink.

## Local recovery

The local helper remains available when the bot or model is unavailable:

```bash
sudo claude-code-session-reset --config /etc/claude-code-telegram-kit/reset.json
```
