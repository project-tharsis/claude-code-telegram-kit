# Telegram Renderer MCP

A project-scoped MCP server that accepts one raw CommonMark/GFM document and deterministically renders it for Telegram.

## Tool

```text
send_reply(chat_id, message_id, content, reply_to?, disable_notification?)
```

The renderer quotes `message_id` by default. Set `reply_to` only to intentionally quote a different message; reactions still target `message_id`.

## Hook-driven tool disclosure

`examples/telegram-settings.json` wires `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `Stop`, and `StopFailure` to four internal MCP tools. The internal tools are denied to the model but remain callable by Claude Code's supported `mcp_tool` hook handler.

One direct Telegram turn owns at most one silent progress bubble. Tool names map to a fixed safe label set; raw tool input, output, commands, paths, URLs, and provider errors are never accepted by the disclosure tools. Updates debounce, deduplicate by `tool_use_id`, stop after a Telegram flood response, and never block the agent or final reply.

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
