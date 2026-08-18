# Telegram Renderer MCP

A project-scoped MCP server that accepts one raw CommonMark/GFM document and deterministically renders it for Telegram.

## Tool

```text
send_reply(chat_id, content, reply_to?, disable_notification?)
```

## Routing

- GFM pipe tables, task lists, `<details>`, and block math use `sendRichMessage` when within the Rich Message limit.
- Ordinary Markdown uses Telegram MarkdownV2.
- Oversized legacy replies are split before sending.
- CJK downgrade is a deployment policy; this package keeps CJK rich structures eligible by default.

## Failure semantics

- Permanent Rich parser/capability rejection may fall back to MarkdownV2.
- Permanent MarkdownV2 rejection may fall back to plain text.
- Timeout, 429, 5xx, transport, and unknown outcomes never trigger a resend.
- A proven endpoint capability failure latches Rich off for the MCP process lifetime.

## Authority

The server reads the official Channel state directory:

```text
${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}
```

It requires `.env` and `access.json` to be regular files owned by the service user with mode `0600`, `dmPolicy: allowlist`, and the destination chat in `allowFrom`.
