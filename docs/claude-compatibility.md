# Claude Code compatibility gate

Memory Harness v0.4 depends on upstream Claude Code contracts rather than patching Claude Code itself.

## Supported floor

Minimum supported Claude Code version: **2.1.196**.

This floor covers both required upstream changes:

- Stop and SubagentStop registry payloads include `background_tasks` and `session_crons` from 2.1.181 onward.
- common hook input includes `prompt_id` from 2.1.196 onward.

The development and live-canary baseline is Claude Code **2.1.243**.

Authoritative references:

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code memory reference](https://code.claude.com/docs/en/memory)
- [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference)

## Required contracts

A compatible deployment must prove all of the following before enabling review or apply:

1. `settings.json` contains one explicit canonical absolute `autoMemoryDirectory`.
2. That directory already exists, is user-owned, is not symlinked, and is not writable by group or other.
3. Stop payloads contain:
   - `session_id`
   - `prompt_id`
   - `hook_event_name: "Stop"`
   - boolean `stop_hook_active`
   - `last_assistant_message`
   - arrays `background_tasks` and `session_crons`
4. Missing task-registry arrays are registry-unavailable, not idle.
5. Isolated title/review workers run in their own process group; timeout kills and reaps descendants.

## Preflight

```bash
python3 scripts/check_claude_compatibility.py \
  --claude /home/USER/.local/bin/claude \
  --settings /home/USER/claude-bot-workspace/telegram-settings.json
```

For activation, temporarily add the following command as the last Stop hook, run one benign turn,
and then remove the hook immediately:

```bash
/usr/local/sbin/claude-check-compatibility \
  --capture-stop-payload /home/USER/.local/state/claude-code-telegram-kit/compat/stop.json
```

Validate that private capture with the normal preflight:
```bash
python3 scripts/check_claude_compatibility.py \
  --claude /home/USER/.local/bin/claude \
  --settings /home/USER/claude-bot-workspace/telegram-settings.json \
  --stop-payload /home/USER/.local/state/claude-code-telegram-kit/compat/stop.json
```

The payload file is transient private canary state and must be deleted after successful validation. It is never committed.
