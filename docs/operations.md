# Operations Runbook

## Authority model

- GitHub `main` and signed/annotated release tags are source authority.
- Local development happens in a Git clone or worktree.
- Runtime executes only `~/.local/share/claude-code-telegram-kit/current`, an atomic symlink to `releases/<exact-sha>`.
- Bot tokens, allowlists, service units, and reset configuration stay outside Git.
- Never edit files under `current`; fix the repository, merge, and install a new exact SHA.

## Install an exact commit

```bash
git fetch origin
sha=<40-character-commit-sha>
git cat-file -e "$sha^{commit}"
python3 scripts/deploy_local.py install \
  --repo . \
  --ref "$sha" \
  --bun "$(command -v bun)"
python3 scripts/deploy_local.py status
```

Inspect the installation receipt:

```bash
readlink -f ~/.local/share/claude-code-telegram-kit/current
python3 -m json.tool ~/.local/share/claude-code-telegram-kit/current/.installed.json
```

## Configure Claude Code

Copy and adapt:

- `examples/.mcp.json`
- `examples/telegram-settings.json`
- `examples/CLAUDE.md`
- `examples/claude-telegram.service`
- `examples/reset.json`

Keep `examples/reset.json` root-owned when installed under `/etc/claude-code-telegram-kit/reset.json`.

Set `CLAUDE_PROJECT_SESSIONS_DIR` in the `session-control` MCP environment to the one exact Claude project directory. Do not derive it from a model argument or inbound message.

## Install the root helper

Follow the exact-commit/digest procedure in `packages/session-control-mcp/README.md`. Do not install it from a mutable `current` symlink. When the helper changes, install it from the same merged SHA before restarting the service, then require:

```bash
/usr/local/sbin/claude-code-session-reset --capabilities
```

The receipt must report protocol `3` with `reset` and `resume`.

A fresh reset also requires the SessionStart receipt writer, installed from the same merged SHA:

```bash
git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_session_receipt.py > /tmp/claude-session-start-receipt
sha256sum /tmp/claude-session-start-receipt
sudo install -o root -g root -m 0755 /tmp/claude-session-start-receipt /usr/local/sbin/claude-session-start-receipt
sudo sha256sum /usr/local/sbin/claude-session-start-receipt

git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_control_guard.py > /tmp/claude-control-command-guard
sha256sum /tmp/claude-control-command-guard
sudo install -o root -g root -m 0755 /tmp/claude-control-command-guard /usr/local/sbin/claude-control-command-guard
sudo sha256sum /usr/local/sbin/claude-control-command-guard

git show <exact-commit-sha>:packages/session-control-mcp/scripts/claude_code_usage_snapshot.py > /tmp/claude-usage-snapshot
sha256sum /tmp/claude-usage-snapshot
sudo install -o root -g root -m 0755 /tmp/claude-usage-snapshot /usr/local/sbin/claude-usage-snapshot
sudo sha256sum /usr/local/sbin/claude-usage-snapshot
sudo install -d -o USER -g USER -m 0700 /home/USER/.local/state/claude-code-telegram-kit
```

Replace `USER` in the directory command and `statusLine` path with the service account. Wire the receipt writer as the `SessionStart` `startup` command hook with `--directory` pointing to the same service-user-owned `0700` path configured as `session_start_receipt_dir` in root-owned `reset.json`. The writer deliberately does not read the root config, so that config may remain private mode `0600` (or `0644`). Wire the control guard in parallel with the `UserPromptSubmit` MCP dispatcher: the guard has no side effects and ensures control namespaces never reach the LLM even when MCP is unavailable. The writer rejects spoofed or malformed input and publishes a `0600` single-link receipt named by the exact session UUID; the root helper independently revalidates the directory and receipt.

## Restart and verify

```bash
sudo systemctl daemon-reload
sudo systemctl restart claude-telegram.service
systemctl is-active claude-telegram.service
```

Verify from the real destination:

1. ordinary final Markdown is delivered by the Stop hook with correct bold/code rendering and no model-facing reply tool call;
2. a GFM table is delivered by the same Stop hook as native Rich Message;
3. a direct message receives `👀`, then a confirmed reply replaces it with `👍`;
4. a definitive local failure becomes `👎`, while timeout/unknown keeps `👀`;
5. a multi-tool turn creates one silent progress bubble with bold tool labels, escaped monospace previews, mobile-width truncation, redacted credentials, and success/failure state;
6. typing remains visible across a long turn and stops before the final reply;
7. with either persisted login or `CLAUDE_CODE_OAUTH_TOKEN`, an exact runtime `authentication_failed` event stops sustained typing/progress and sends one quoted auth explanation;
8. `/usage` remains available during auth failure and returns the latest private statusLine `rate_limits` snapshot as bold percentages and compact micro-bars without an extra Claude process or model turn;
9. `/sessions` returns at most ten UUID-free entries and stores a private snapshot;
10. `/resume N` uses a one-shot confirmation, reaches the selected session, restores the unit to `--continue`, and retains rollback;
11. `/reset` uses a one-shot confirmation, sends accepted/completion messages, and leaves no synthetic LLM seed;
12. Claude, the sole official Telegram poller, renderer MCP, and control MCP are alive.

## Rollback

```bash
python3 scripts/deploy_local.py rollback
python3 scripts/deploy_local.py status
sudo systemctl restart claude-telegram.service
```

Reinstall the root helper from the previous reviewed commit if it changed. Repeat destination readback after rollback.

## Break-glass reset

When the model or Telegram channel cannot process `/reset`:

```bash
sudo claude-code-session-reset \
  --config /etc/claude-code-telegram-kit/reset.json
```

The helper preserves old transcripts and restores the previous session if fresh startup fails.
