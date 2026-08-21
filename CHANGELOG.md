# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-08-21

### Added

- Deterministic pre-LLM Telegram controls: `/usage`, `/sessions`, `/resume N`, `/reset`, `/rename NAME`, and `/model`. Destructive controls are private-chat only, confirmation challenges are action/session bound and single-use, and handled control commands never reach the model.
- Session catalog and exact-session resume with bounded metadata-only titles. `/rename NAME` creates a permanent user-owned title, while the first meaningful Stop can generate one validated Haiku title through Claude's official zero-turn local `/rename --resume` path.
- One-time `/model` reply keyboard, root-owned `ANTHROPIC_MODEL` persistence, exact process-environment readback, and optional per-chat Telegram command menus.
- Hermes-style tool progress with configurable `safe`/`all`/`verbose` disclosure, full parent/subagent step visibility, bounded code/path/query previews, credential redaction, sustained typing, deterministic completion state, and no tool-output leakage.
- Deterministic `/usage` from Claude's documented private `statusLine.rate_limits` snapshot, plus quoted runtime authentication-failure delivery from the exact trusted transcript append.
- Successful Claude `Artifact` results can send up to four quoted documents after the canonical final text. Discovery scans the bounded transcript tail. Files are sent one at a time with size-aware timeouts; no registration or file-send tool exists.
- Broker Protocol v2 and Session Control Protocol v5 add exact current-session identity to reset, plus systemd socket activation, service hardening, and an exact-commit root-asset installer with rollback.

### Changed

- Final Telegram delivery is now Stop-owned and deterministic: Claude returns canonical Markdown, the internal hook sends it exactly once, proven oversized local replies request one shorter replacement, and uncertain outcomes are never retried.
- Fresh reset bootstrap is prompt-free and non-modal. A `SessionStart` command hook, exact UUID/process checks, the official Channel poller, renderer/control workers, and restored `--continue` unit state jointly prove readiness.
- Rich delivery canonicalizes GFM through mdast before `sendRichMessage`, preserving literal markers while retaining valid emphasis, code, links, tables, and Telegram underline.
- Slash-control replies use concise Telegram HTML hierarchy, escaped titles, code-formatted commands/values, honest metadata-only title fallbacks, and no exposed UUID/path internals.
- Progress remains fully visible until Telegram's 4096-character wire limit instead of folding after eight steps; shell commands use a bounded one-line block and Skill calls name the loaded Skill.
- Each progress bubble selects one stable Claude-style spinner/completion verb pair for the turn, such as `Brewing…` → `Brewed`; Telegram marks the header with `✦`/`✓` and separates it from the tool steps.
- Monorepo packages and both MCP server identities advance to `0.3.0`.

### Security

- The unprivileged control MCP no longer executes `sudo`, `systemd-run`, caller-selected helper/config paths, service names, unit names, or arbitrary privileged argv. It can only write bounded requests to a mode-`0600`, non-root-service-user-owned Unix socket.
- The root broker verifies `SO_PEERCRED`, strict JSON types/keys, fixed paths and argv, socket deadlines, helper capabilities, 12 mutations per minute, and at most four concurrent helper jobs. UID `0` service identities are rejected.
- Root helper operations use absolute `/usr/bin/systemctl`, bounded timeouts, and exact supplied old/new session identities; rollback authority is never inferred from transcript mtimes.
- Root idempotency receipts expire after 30 days and fail closed at 4096 entries.
- The dead `bind_command`, `list_sessions`, and `resume_session` MCP surfaces are removed; `dispatch_command` is the sole deterministic control router.
- The legacy hidden `send_reply` direct-call surface and reservation path are removed; the renderer accepts only its five declared hook tools.
- Artifact delivery anchors every directory and file through trusted directory descriptors, requires same-UID private regular files, rejects links/writable/nested/oversized paths, bounds reads and aggregate memory, and never retries an unknown upload outcome.
- The legacy model-facing `schedule_session_reset` surface is removed. Confirmed `/reset` remains exclusively on the deterministic pre-LLM path.
- Telegram authority parsing accepts only exact direct Channel envelopes, rejects malformed or duplicate authority attributes, and keeps recipient allowlisting independent from transcript discovery.

### Fixed

- Runtime auth failures now stop typing/progress and produce one quoted recovery message without credential preflight, storage, background polling, or expiry-warning policy.
- Model switching and rollback wait for the Claude CLI, official poller, renderer, and control workers instead of treating systemd `active` as readiness.
- Renderer sends quote the inbound message by default across Rich, MarkdownV2, plain-text fallback, controls, and Artifact documents.
- Text and control sends use a 10-second timeout; Artifact documents use a bounded size-aware budget and reactions retain the 3-second bound. Only typed uncertain outcomes preserve `👀`; proven local/permanent failures finalize `👎`.
- Rich capability `404` responses use a 30-minute cooldown rather than permanently disabling Rich delivery for the process.
- The official `plugin:telegram:telegram` Channel source binds correctly while prefix/suffix variants continue to fail closed.
- Control commands no longer create progress bubbles that a reset/restart cannot close, and subagent disclosure no longer exposes underlying commands or private paths.
- Automatic title hooks keep exact session/transcript authority while allowing Claude's tool cwd to change during the turn.
- Finals above the semantic 100,000-character limit now close progress and enter the existing one-retry shorter-answer path instead of being swallowed by hook validation.
- `bind_turn` now advertises its optional transcript authority, and example hook inputs are contract-checked against every renderer tool declaration.
- Read/Edit/Write-family progress previews show filenames rather than absolute paths.
- Version checks now require a dated Changelog heading matching the package/server/lock version.
- Regression tests cover root config, receipts, helper recovery, descriptor cleanup, Artifact IDs, Unicode boundaries, version drift, and exact release extraction.

### Upgrade notes

- The `0.2.0` direct helper environment (`CLAUDE_SESSION_RESET_HELPER` and `CLAUDE_SESSION_RESET_CONFIG`) is no longer part of the unprivileged MCP configuration.
- Deploy the exact `v0.3.0` user release, then run `scripts/install_root_assets.py` from that exact tagged checkout to install the root broker/helper, socket/template units, and Claude service hardening. Verify the root manifest and destination hashes before restart.
- Enable `claude-code-control.socket`, reload systemd, restart the Claude service, and verify Broker Protocol v2 / Session Control Protocol v5 capabilities plus `NoNewPrivileges=yes`, an empty effective capability set, one official poller, and both sidecars.
- Roll back root assets before the user release when returning to `0.2.0`; otherwise its direct privileged control path is correctly blocked by `NoNewPrivileges`.

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
