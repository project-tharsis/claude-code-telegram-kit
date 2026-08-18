# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
