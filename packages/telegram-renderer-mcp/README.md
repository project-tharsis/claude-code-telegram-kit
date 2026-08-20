# Telegram Renderer MCP

A project-scoped MCP server that accepts one raw CommonMark/GFM document and deterministically renders it for Telegram.

## Tool

```text
send_reply(chat_id, message_id, content, reply_to?, disable_notification?)
```

The renderer quotes `message_id` by default. Set `reply_to` only to intentionally quote a different message; reactions still target `message_id`.

## Hook-driven tool disclosure

`examples/telegram-settings.json` wires `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and `StopFailure` to five internal MCP tools. The internal tools are denied to the model but remain callable by Claude Code's supported `mcp_tool` hook handler.

One direct Telegram turn owns at most one silent progress bubble. `TELEGRAM_TOOL_DISCLOSURE_MODE` selects `safe`, `all`, or `verbose`; verbose shows bounded commands, paths, queries, URLs, integration names, and delegation descriptions while hard-redacting credential values. Tool outputs never enter disclosure. PostToolUse events render running (`…`), completed (`✓`), and failed (`✕`) state. Updates debounce, deduplicate by `tool_use_id`, stop after a Telegram flood response, and never block the agent or final reply.

For each ordinary direct turn, the renderer watches only that turn's trusted transcript append for at most five seconds. An exact runtime `authentication_failed` event stops sustained typing/progress and sends one quoted Telegram explanation. This is auth-source agnostic: persisted `claude login` and `CLAUDE_CODE_OAUTH_TOKEN` follow the same failure path. Normal Stop cancels the watcher. The harness neither preflights, issues, stores, nor validates credentials and has no background auth polling, expiry warning, or token-lifetime policy.

The renderer also owns sustained Telegram typing after the official Channel's initial one-shot action: refresh every two seconds, 1.5-second request timeout, 10-second 429 cooldown, 10-minute dead-man cutoff, and cancellation before final delivery, Stop/StopFailure, or a superseding turn.

## Routing

- GFM pipe tables, task lists, `<details>`, and block math use `sendRichMessage` when within the Rich Message limit.
- Ordinary Markdown uses Telegram MarkdownV2.
- Ordinary replies whose rendered MarkdownV2 exceeds 4,096 characters fail before any network call; the caller must shorten the answer.
- CJK downgrade is a deployment policy; this package keeps CJK rich structures eligible by default.

## Failure semantics

- Permanent Rich parser/capability rejection may fall back to MarkdownV2.
- Permanent MarkdownV2 rejection may fall back to plain text.
- Timeout, 429, 5xx, transport, and unknown outcomes never trigger a resend.
- A proven endpoint capability failure holds Rich off for a 30-minute cooldown, then re-probes.
- A progress send with an unknown outcome is never retried. Transient edits keep identity for a later catch-up; a 429 abandons disclosure for that turn rather than consuming Telegram's flood budget.

## Processing reactions

Enable the official Channel acknowledgement in `access.json`:

```json
{
  "ackReaction": "👀"
}
```

The renderer then replaces the triggering message reaction deterministically:

- successful Telegram reply → `👍`
- definitive local/parser/delivery rejection → `👎`
- timeout, rate limit, server error, or unknown delivery outcome → leave `👀`
- input rejected before delivery (empty, oversized, malformed) → `👎`

Install [`examples/access-ux.json`](../../examples/access-ux.json) to enable the initial `👀`; no Claude hook is required. Reaction calls are bounded, do not follow redirects, and are best-effort: a reaction failure never changes a confirmed reply result.

## Authority

The server reads the official Channel state directory:

```text
${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}
```

It requires `.env` and `access.json` to be regular files owned by the service user with mode `0600`, `dmPolicy: allowlist`, and the destination chat in `allowFrom`.
