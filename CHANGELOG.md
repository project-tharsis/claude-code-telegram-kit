# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The official Claude Code Telegram Channel emits `<channel source="plugin:telegram:telegram" …>` on inbound messages. The sidecar envelope parser now accepts that exact source in addition to the earlier `telegram` value, so hook turn binding and `/sessions`/`/resume` capabilities bind again. Prefix or suffix variants still fail closed.
- Control slash commands (`/sessions`, `/resume N`, `/reset`) no longer create tool-progress bubbles, which resume/reset could never close before restarting Claude.
- Root reset configuration may use either secure root-owned mode `0600` or `0644`; the unprivileged scheduler and privileged helper now enforce the same exact mode set.

### Added

- Hook-driven Telegram tool disclosure: Claude Code `mcp_tool` hooks bind each direct inbound turn and maintain one silent, bounded, edit-in-place progress bubble without exposing raw tool arguments or output.
- Deterministic pre-LLM Telegram control routing: `/sessions` lists up to ten recent sessions directly, while `/reset` and `/resume N` use action-bound, session-bound, single-use 60-second confirmation challenges. The MCP dispatcher blocks handled commands before the model, a side-effect-free command hook keeps control namespaces blocked during MCP outages, destructive controls are private-chat only, and all session-control tools are denied to model use.
- Session Control Protocol v3 between the unprivileged TypeScript MCP and the root-owned Python helper, including a read-only capability preflight, exact current/target session binding, durable action-bound receipts, exact worker health checks, and rollback.
- Deterministic seedless session reset: a fresh `--session-id` start injects no prompt, a `SessionStart` command hook publishes a secure receipt under the service user, and the root helper accepts only the exact receipt plus process/poller/worker health as readiness. No LLM response and no transcript content prove readiness, and the first real Telegram message is the first user turn, so Claude's native `ai-title` is no longer anchored to a synthetic handshake.

### Fixed

- User-facing Telegram sends wait 10 s instead of 3 s, so ordinary tail latency no longer reports a delivered reply as an unknown outcome. Reactions keep the 3 s bound.
- A Rich capability 404 now holds Rich off for a 30-minute cooldown instead of the whole process lifetime, so a revoked token or an intermediary 404 can no longer silently downgrade rendering indefinitely.
- Inputs rejected before delivery now finalize the processing reaction as `👎` instead of leaving `👀` in place. Delivery raises a typed `TelegramUncertainOutcomeError`, and only that error preserves `👀`.
- Renderer replies now quote the inbound Telegram message by default across Rich, MarkdownV2, and plain-text fallback; explicit `reply_to` remains an override. `/reset` acceptance quotes the triggering command while later control notifications remain independent.

## [0.2.0] - 2026-08-18

### Added

- Telegram processing reaction lifecycle: official-channel `👀` acknowledgement and deterministic renderer `👍`/`👎` finalization.
- Confirmed `/reset` acceptance replaces `👀` with `👍` before the reset job is scheduled.
- Required inbound `message_id` on `send_reply` so final reactions target the exact triggering message.

### Changed

- Monorepo and MCP server versions advance to `0.2.0`.
- All Telegram Bot API clients reject redirects, cap JSON responses at 64 KiB, and reject lossy numeric message IDs.

## [0.1.0] - 2026-08-18

### Added

- Canonical raw-Markdown Telegram renderer with deterministic Rich Message and MarkdownV2 routing.
- Approval-gated session-control MCP with direct Telegram acknowledgements and durable reset idempotency.
- Root-owned, fail-closed Claude Code session reset helper with rollback to the previous session.
- Exact-SHA versioned local installation, atomic activation, and rollback tooling.
- Public-tree privacy checks, strict TypeScript, Python 3.11/3.12 CI, dependency audit, and OSS governance files.
