# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Slash-control replies now share Telegram HTML typography: bold hierarchy, italic metadata, code-formatted commands/values, escaped session titles, and concise success/failure copy. Root completion messages no longer expose truncated session UUIDs.
- Sessions without native `ai-title` records now use honest metadata-only fallbacks: `Conversation with Claudio` after a concrete assistant turn, otherwise `Control-only session`. Prompt text is never reused as a title.
- Model switching now waits for the Claude CLI, official poller, and both sidecars to become healthy after each restart instead of treating the earlier systemd `active` edge as readiness; rollback uses the same bounded health proof.
- Native Rich delivery now canonicalizes GFM through mdast before `sendRichMessage`, preserving literal multiplication stars, intraword underscores, empty delimiter runs, and unmatched markers without breaking valid emphasis, code, links, tables, or Telegram underline.
- Verbose Telegram tool disclosure no longer lets one command or path consume most of a mobile screen.
- Progress disclosure no longer folds after eight lines: it keeps every normal parent and subagent tool step visible, uses Telegram code blocks for sanitized previews, names `Skill` calls explicitly, and reserves folding for the 4096-character wire limit.
- Progress labels now come from one fixed allowlist, and `/usage` names rolling quota windows as 5-hour / 7-day limits instead of conversation or calendar periods.
- The official Claude Code Telegram Channel emits `<channel source="plugin:telegram:telegram" …>` on inbound messages. The sidecar envelope parser now accepts that exact source in addition to the earlier `telegram` value, so hook turn binding and `/sessions`/`/resume` capabilities bind again. Prefix or suffix variants still fail closed.
- Control slash commands (`/usage`, `/sessions`, `/resume N`, `/reset`) no longer create tool-progress bubbles, which resume/reset could never close before restarting Claude.
- Root reset configuration may use either secure root-owned mode `0600` or `0644`; the unprivileged scheduler and privileged helper now enforce the same exact mode set.
- The unprivileged SessionStart receipt writer no longer reads root-owned `reset.json`; its fixed user-owned receipt directory is passed by the supported command-hook configuration and independently revalidated by the root helper, so private `0600` root config works end to end.

### Added

- Automatic semantic session titles: the first successful Stop runs one bounded, isolated Haiku title call per session from an auth-inheriting command hook, validates the result, and persists it through the official zero-turn `/rename` local-command path with exact readback. `/sessions` and `/reset` are best-effort backstops, while `/rename NAME` creates a permanent user-owned override.
- `/model` now returns a one-time Telegram reply keyboard with `1 · Opus`, `2 · Sonnet`, `3 · Haiku`, and `4 · Inherit`; each button sends an exact deterministic control payload, and the pending acknowledgement removes the keyboard before restart.
- Allowlisted private chats can opt into a Telegram command menu through chat-specific `setMyCommands` scopes, with an explicit `delete` mode for verified offboarding. The menu advertises only official commands and deterministic Harness controls; it never polls, grants authority, or exposes parameterized `/resume N`.
- Deterministic Telegram `/model`: exact UserPromptSubmit routing, a fixed `opus|sonnet|haiku|inherit` allowlist, Protocol v4 root-helper restart/rollback, root-owned `ANTHROPIC_MODEL` persistence, and process-environment health readback without model invocation or TUI key injection.
- Deterministic Stop-hook final delivery: Claude returns canonical Markdown as `last_assistant_message`; the bound `finish_turn` hook invokes the internal renderer exactly once, while model-facing renderer/official reply tools are hidden or denied. Proven oversized local replies block Stop once for a shorter replacement; unknown outcomes are never retried.
- Telegram-native progress and usage emphasis: progress headers/tool labels render in bold HTML, argument previews render as escaped monospace code and truncate to 40 characters in `verbose` / 28 in `all`, while `/usage` renders bold percentages with ten-cell micro-bars.
- Auth-source-agnostic runtime failure delivery: each ordinary Telegram turn watches only its trusted transcript append for at most five seconds. An exact `authentication_failed` event stops sustained typing/progress and sends one quoted explanation for either persisted login or `CLAUDE_CODE_OAUTH_TOKEN`; normal Stop cancels the watcher. No credential preflight, storage, background polling, or expiry-warning policy is added.
- Hermes-style Telegram execution UX: configurable `safe`/`all`/`verbose` disclosure with bounded command/path/query previews, hard credential redaction, running/completed/failed tool state, and one silent edit-in-place bubble. Tool output never enters disclosure.
- Sustained Telegram typing heartbeat: two-second refresh, bounded requests, throttle cooldown, dead-man cutoff, and deterministic cancellation before final delivery or turn closure.
- Deterministic `/usage`: Claude's documented `statusLine.rate_limits` is atomically cached as a private service-user snapshot and returned pre-LLM; no extra Claude process, OAuth poll, model turn, or session history is created.
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
