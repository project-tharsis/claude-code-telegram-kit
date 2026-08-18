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

## Install the root helper

Follow the exact-commit/digest procedure in `packages/session-control-mcp/README.md`. Do not install it from a mutable `current` symlink.

## Restart and verify

```bash
sudo systemctl daemon-reload
sudo systemctl restart claude-telegram.service
systemctl is-active claude-telegram.service
```

Verify from the real destination:

1. ordinary Markdown reply returns `mode: markdownv2`;
2. a GFM table returns `mode: rich`;
3. a direct message receives `👀`, then a confirmed reply replaces it with `👍`;
4. a definitive local failure becomes `👎`, while timeout/unknown keeps `👀`;
5. `/reset` requires approval;
6. reset sends accepted and completion messages;
7. the new session transcript contains exact `READY`;
8. Claude, the official Telegram poller, renderer MCP, and control MCP are alive.

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
