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

# Install the activator, its fixed config, and the systemd EnvironmentFile drop-in
# from the same exact SHA before first use or whenever root assets change.
sudo python3 scripts/install_root_assets.py install \
  --repo . \
  --commit "$sha" \
  --service-user USER
sudo systemd-tmpfiles --create /usr/lib/tmpfiles.d/claude-code-telegram-kit.conf
sudo systemctl daemon-reload

python3 scripts/deploy_local.py install \
  --repo . \
  --ref "$sha" \
  --bun "$(command -v bun)"
python3 scripts/deploy_local.py status
# The install output must say activation_required=true.
sudo /usr/local/sbin/claude-runtime-activate "$sha"
```

The root activator accepts only the exact SHA. Its fixed root-owned configuration names the
service account (the installer renders `USER` to that account); it does not accept unit, path,
argv, or runtime-role overrides. Before restart it writes a root-owned activation generation
containing the requested SHA. The fixed systemd drop-in injects that generation into the new
process tree. Readiness requires a new systemd `MainPID`, `ActiveState=active`,
`SubState=running`, the fixed service cgroup, and exactly one official Channel poller, renderer
MCP, and session-control MCP whose process environments carry that same SHA and generation.
The core role PID set must be stable for two observations; unrelated transient hook processes are
ignored. `current` is descriptor-anchored and revalidated throughout activation.

Activation never changes the service-user-owned `current` or `previous` symlinks. On failure it
writes no success receipt. Rollback is an explicit two-step operator action:

```bash
python3 scripts/deploy_local.py rollback
python3 scripts/deploy_local.py status  # read the restored exact current SHA
sudo /usr/local/sbin/claude-runtime-activate <restored-40-character-sha>
```

`deploy_local.py` and the root activator share a root-owned runtime lock, so a normal release
switch cannot race activation. The activation receipt is root-owned mode `0600` and contains only
the exact SHA, generation, old/new MainPID, and the three bounded role PIDs.

Inspect the installation receipt:

```bash
readlink -f ~/.local/share/claude-code-telegram-kit/current
python3 -m json.tool ~/.local/share/claude-code-telegram-kit/current/.installed.json
sudo find /var/lib/claude-code-telegram-kit/activation -maxdepth 1 -type f -name 'activation-*.json' -printf '%T@ %p\n' | sort -nr | head -1
```

Read the exact activation receipt path returned by `claude-runtime-activate` with
`sudo python3 -m json.tool <receipt-path>` and verify `release_sha`, `generation`,
`old_main_pid`, `new_main_pid`, and the three role PIDs before calling the feature active.

## Configure Claude Code

Copy and adapt:

- `examples/.mcp.json`
- `examples/telegram-settings.json`
- `examples/CLAUDE.md`
- `examples/claude-telegram.service`
- `examples/claude-telegram-hardening.conf`
- `examples/claude-telegram-activation.conf`
- `examples/claude-code-telegram-kit-tmpfiles.conf`
- `examples/claude-code-control.socket`
- `examples/claude-code-control@.service`
- `examples/reset.json`

Keep `examples/reset.json` root-owned when installed under `/etc/claude-code-telegram-kit/reset.json`.

The system service must include `EnvironmentFile=-/etc/claude-code-telegram-kit/model.env` and a fixed `CLAUDE_TITLE_CLI` path to the same reviewed Claude executable used by `ExecStart`. Do not create the model file manually: `/model <alias>` owns it through the root helper, and `inherit` removes it atomically.

Set `CLAUDE_WORKSPACE_DIR` and `CLAUDE_PROJECT_SESSIONS_DIR` in the Claude service environment because command hooks inherit the service environment. Pass the same exact values into the `session-control` MCP, and pass the same `CLAUDE_PROJECT_SESSIONS_DIR` into the renderer MCP. Do not derive any of these paths from a model argument or inbound message.

## Install the root broker and helper

Follow the exact-commit/digest procedure in `packages/session-control-mcp/README.md`. Do not install it from a mutable `current` symlink. When the helper changes, install it from the same merged SHA before restarting the service, then require:

```bash
/usr/local/sbin/claude-code-session-reset --capabilities
```

The helper receipt must report protocol `5` with `reset`, `resume`, and `model`, plus `opus`, `sonnet`, `haiku`, and `inherit`. Install the broker and both systemd units from the same SHA by the procedure in the package README. The socket must be mode `0600`, owned by the exact service user, and enabled before the Claude service starts.

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
sudo systemctl enable --now claude-code-control.socket
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
9. `/resume` returns at most ten HTML-escaped, UUID-free entries, stores a private snapshot, and renders missing native titles as `Conversation with Claudio` or `Control-only session` without reading prompt text; legacy `/sessions` returns the same list;
10. `/model` reports the latest actual model and bot override; `/model sonnet` persists a root-owned override, restarts the same `--continue` session, verifies the process environment, and rolls back on failed health;
   `/model` also renders a compact 2×2 one-time model keyboard plus `5 · Cancel`; selecting `2 · Sonnet` switches deterministically, while Cancel only removes the keyboard;
11. `/resume N` uses a one-shot confirmation, reaches the selected session, restores the unit to `--continue`, and retains rollback;
12. `/reset` uses a one-shot confirmation, sends typographic accepted/completion messages without any session identifier, and leaves no synthetic LLM seed;
13. Claude, the sole official Telegram poller, renderer MCP, and control MCP are alive.
14. when command-menu sync is enabled, `getMyCommands` for the allowlisted chat-specific scope returns exactly `/start`, `/help`, `/status`, `/usage`, `/resume`, `/model`, and `/reset`; the official `all_private_chats` scope remains untouched.
15. `/usr/bin/flock` is present and executable; the first meaningful Stop creates at most one `0600` per-session title-state record, makes one isolated Haiku call, appends a verified `custom-title` through the official zero-turn `/rename` local-command path and exact readback, and never exposes credentials, prompt bodies, UUIDs, paths, or tool inputs in Telegram;
16. `/rename NAME` writes the exact current session, returns escaped HTML, marks `USER_LOCKED`, and survives later Stops, `/resume`, `/reset`, and resume without automatic overwrite.
17. `systemctl show claude-telegram.service -p NoNewPrivileges` returns `yes`; `sudo` from a process with the same service hardening fails, while Broker Protocol `capabilities` succeeds through the private socket.
18. a successful Claude `Artifact` tool call sends one quoted silent document after the canonical final text; failed/unmatched, wrong-session, symlink, hardlink, writable, oversized, and uncertain files never replay or expose a path.

Before removing an allowlisted private chat or disabling menu sync, set `TELEGRAM_COMMAND_MENU_ENABLED=delete`, restart once, verify the chat-specific `getMyCommands` result is empty, then remove the chat or env key. A stale menu never grants authority, but verified cleanup keeps Telegram UI aligned with the live allowlist.

## Rollback

```bash
sudo python3 scripts/install_root_assets.py rollback
sudo systemctl daemon-reload
python3 scripts/deploy_local.py rollback
python3 scripts/deploy_local.py status
sudo /usr/local/sbin/claude-runtime-activate "$(python3 scripts/deploy_local.py status | python3 -c 'import json,sys; print(json.load(sys.stdin)["current"])')"
```

Reinstall the root broker, helper, and unit files from the previous reviewed commit if they changed. Restore the previous Claude unit before disabling the broker socket; otherwise `NoNewPrivileges` correctly prevents the old `sudo systemd-run` path. Repeat destination readback after rollback.

## Break-glass reset

When the model or Telegram channel cannot process `/reset`:

```bash
sudo claude-code-session-reset \
  --config /etc/claude-code-telegram-kit/reset.json \
  --action reset \
  --current-session-id <exact-current-session-uuid>
```

The helper preserves old transcripts and restores the previous session if fresh startup fails.
