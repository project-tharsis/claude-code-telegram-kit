# Design invariants

The README lists the five invariants that define the project's blast radius. This is the complete set.

## Transport

- One Telegram `getUpdates` consumer per bot token. The official Channel keeps it.
- No arbitrary Bot API method tool.
- No arbitrary shell command tool.
- Raw Markdown is canonical; transport choice is deterministic, never model-selected.
- Rich fallback occurs only after clearly permanent parser or capability rejection.
- Timeouts, 429s, 5xx responses, and unknown outcomes never trigger a resend.
- Every Bot API request rejects redirects; JSON responses are capped at 64 KiB before parsing.
- User-facing sends allow 10 s for Telegram tail latency; reactions abort at 3 s so UX never delays a reply.
- Telegram message IDs converted to numbers must be positive safe integers.
- User-facing replies quote the inbound message by default; an explicit `reply_to` only overrides the quote target, never the reaction target.
- A proven endpoint capability failure holds Rich off for a bounded cooldown, then re-probes, because a 404 is also what a revoked token or an intermediary returns.
- Single-chat allowlisting is the default; multi-chat routing requires an explicit opt-in.

## Processing reactions

- The official Channel owns the initial `👀` acknowledgement.
- A confirmed user-facing reply may replace `👀` with `👍`.
- Only a definitive local/parser/delivery failure may replace `👀` with `👎`, including inputs the tool rejects before any send.
- The reply tool owns every `👎`; delivery raises a typed unknown-outcome error the tool never converts into one.
- Timeout, rate-limit, server, transport, and unknown outcomes leave `👀` unchanged.
- Reaction failures are best-effort and never change the main reply result.
- Cancellation and `StopFailure` leave `👀` unchanged in v0.2 because the official Channel exposes no trusted per-turn lifecycle correlation to sidecars.

## Tool disclosure

- Claude Code hooks, not the model, emit disclosure events.
- Disclosure accepts turn/tool/agent IDs plus an explicit allowlist of bounded preview strings (`command`, `file_path`, `path`, `pattern`, `query`, `url`, `description`). It never accepts the raw `tool_input` object or any tool output.
- `verbose` may expose ordinary VM commands, paths, queries, and URLs by user choice. Credential-shaped values are always replaced with fixed redaction markers before Telegram delivery; previews are then bounded to 48 characters (`verbose`) or 32 (`all`) and HTML-escaped before bold/code rendering.
- PostToolUse and PostToolUseFailure mark each tool ID as running, completed, or failed; one turn still owns one bounded bubble.
- The official Channel owns the initial typing action. The renderer owns sustained two-second refresh and cancels before final delivery, turn closure, supersession, rejection, or a ten-minute dead-man cutoff.
- Each ordinary direct turn may watch only its exact, secure transcript append for at most five seconds. An exact runtime `authentication_failed` row retires the progress turn and sends one quoted explanation, independent of whether Claude used persisted login or `CLAUDE_CODE_OAUTH_TOKEN`. Normal Stop/supersession cancels the watcher. No credential preflight, background auth polling, or token policy belongs to the harness.
- A direct Telegram envelope and live allowlist bind the turn. Missing or malformed binding suppresses disclosure.
- Presentation is fail-open for the agent: hook, send, edit, throttle, and restart failures never block tool execution or the final reply.
- One turn owns at most one replacement progress bubble; unknown sends are never retried and 429 ends disclosure for that turn.

## Session continuity

- Exact session-control commands are parsed and handled by a UserPromptSubmit hook before the LLM; ordinary messages alone reach the model.
- A side-effect-free command hook blocks control namespaces even if the MCP dispatcher is unavailable. Every session-control MCP tool is denied to the model; permissions are the provenance boundary for the mutating dispatcher.
- A numbered list is an atomic, private, ten-minute snapshot. Later session activity never repoints a visible index.
- `/usage` is read-only and formats a private service-user-owned snapshot of Claude's documented `statusLine.rate_limits`. It starts no extra Claude process, performs no model/API call, and accepts only bounded 5-hour/7-day windows.
- The model supplies neither control commands nor their arguments. It never receives a confirmation code, index, session UUID, transcript path, helper path, service, unit, or command.
- Reset and resume require an action-bound, latest-per-chat, single-use 60-second confirmation challenge before any mutation.
- Resume stays within one root-configured workspace, revalidates at both privilege levels, and rolls back the previous session on failed health checks.
- Official Telegram plugin 0.0.7 does not include `forward_origin` in Channel metadata. An allowlisted user forwarding text whose entire body is an exact command is indistinguishable from typing it; the second exact confirmation message is the safety boundary.

## Reset

- Reset challenge and acceptance messages are sent by the control plane, quote their triggering commands, and are not generated by the model.
- Once that ACK is confirmed, the control plane best-effort replaces `👀` with `👍` before scheduling; reaction failure never blocks reset.
- Reset requests are durably idempotent by inbound `chat_id + message_id`.
- PID 1 owns reset execution before the Claude process is terminated.
- Reset completion and failure notifications remain independent of the original command.
- The root helper is fail-closed: an unreadable or invalid configuration aborts the reset.

## Deployment

- Public source, private credentials, root configuration, and versioned installation remain separate.
- Runtime executes an immutable release directory, never a mutable development checkout.

## Authority

- The renderer and control MCPs reuse the official Channel's token and `access.json` authority.
- They require `dmPolicy: allowlist`, secure `0600` state files, and exact destination membership.
