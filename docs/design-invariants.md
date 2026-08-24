# Design invariants

The README lists the five invariants that define the project's blast radius. This is the complete set.

## Transport

- One Telegram `getUpdates` consumer per bot token. The official Channel keeps it.
- No arbitrary Bot API method tool.
- No arbitrary shell command tool.
- Raw Markdown is canonical; transport choice is deterministic, never model-selected.
- Rich delivery compiles canonical GFM through an AST before native parsing: literal delimiter text is escaped, valid emphasis/code/link/table structure is preserved, and Telegram underline syntax is retained from source positions. A failed compilation downgrades before any Rich request.
- Rich fallback occurs only after clearly permanent parser or capability rejection.
- Timeouts, 429s, 5xx responses, and unknown outcomes never trigger a resend.
- Every Bot API request rejects redirects; JSON responses are capped at 64 KiB before parsing.
- User-facing sends allow 10 s for Telegram tail latency; reactions abort at 3 s so UX never delays a reply.
- Telegram message IDs converted to numbers must be positive safe integers.
- User-facing replies quote the inbound message by default; an explicit `reply_to` only overrides the quote target, never the reaction target.
- A proven endpoint capability failure holds Rich off for a bounded cooldown, then re-probes, because a 404 is also what a revoked token or an intermediary returns.
- Single-chat allowlisting is the default; multi-chat routing requires an explicit opt-in.
- Outbound files originate only from successful Claude `Artifact` tool-use/result pairs parsed from the bounded tail of the exact bound transcript append. No artifact-registration or Telegram file-send tool exists. Transcript parsing is discovery, not an independent authorization boundary: the agent is already permitted to return files from its own exact session scratchpad to the same allowlisted chat; recipient authorization and filesystem confinement are the security boundaries.
- Artifact delivery uses only `sendDocument`, after the canonical final text, from the exact Claude `/tmp/claude-UID/PROJECT/SESSION_UUID/scratchpad/FILE` layout derived from the bound project and session. Files are loaded and sent one at a time with a bounded size-aware upload timeout. Every parent and file is directory-FD anchored and same-UID checked; symlinks, hardlinks, writable files, nested paths, more than four files, files over 50 MiB, and totals over 100 MiB fail closed.
- Confirmed artifact uploads are never replayed. An unknown upload outcome stops the sequence; local or permanent rejection emits at most one fixed failure notice without exposing a path.

## Processing reactions

- The official Channel owns the initial `👀` acknowledgement.
- A confirmed user-facing reply may replace `👀` with `👍`; final delivery is reserved once before the Stop hook calls Telegram.
- Only a definitive local/parser/delivery failure may replace `👀` with `👎`, including inputs the tool rejects before any send.
- The renderer owns every `👎`; typed unknown outcomes are never converted into failure or retried.
- Timeout, rate-limit, server, transport, and unknown outcomes leave `👀` unchanged.
- Reaction failures are best-effort and never change the main reply result.
- Cancellation and `StopFailure` leave `👀` unchanged in v0.2 because the official Channel exposes no trusted per-turn lifecycle correlation to sidecars.

## Tool disclosure

- Claude Code hooks, not the model, emit disclosure events.
- The model returns canonical final Markdown and never chooses a Telegram reply tool or transport. Stop's official `last_assistant_message` field is the sole normal final-delivery input; no renderer reply tool exists, and the official Channel reply tool is denied.
- Disclosure accepts turn/tool/agent IDs plus an explicit allowlist of bounded preview strings (`command`, `file_path`, `path`, `offset`, `limit`, `pattern`, `query`, `url`, `skill`, `description`). It never accepts the raw `tool_input` object or any tool output.
- Parent `Task`/`Agent` calls render as delegation. Nested subagent tools keep their own fixed labels and sanitized previews instead of collapsing behind that parent step.
- Official `SubagentStart`/`SubagentStop` hooks retain bounded agent identity for the exact bound prompt. If an agent is still active after the parent Stop final is delivered, a separate quoted background bubble shows each agent's fixed type and latest verified nested-tool action. It edits only on lifecycle/tool events: no interval, heartbeat, transcript polling, extra model turn, elapsed-time fiction, or subagent final text enters this rail. A later direct prompt does not retire a still-active background bubble.
- `verbose` may expose ordinary VM commands, search paths, queries, and URLs by user choice, while Read/Edit/Write-family file previews use basename only. Credential-shaped values are always replaced with fixed redaction markers before Telegram delivery; ordinary previews are then bounded to 40 characters (`verbose`) or 28 (`all`), while bounded `Skill` names may use up to 128 characters. Fixed emoji and friendly verbs render ordinary previews inline; only `Bash` commands use a one-line Telegram `shell` block. Every dynamic value is HTML-escaped before delivery.
- Bash previews drop only a simple leading `cd <dir> &&` presentation wrapper, then redact retained commands before using a Unicode-safe middle ellipsis. Any named secret prefix truncates the remaining preview after a fixed marker.
- PostToolUse and PostToolUseFailure mark each tool ID as running, completed, or failed. One foreground phase owns one wire-bounded bubble; a retained background-agent phase may own one later bubble after the parent final. Every normal foreground step remains visible, while the background phase retains only each agent's latest verified step. Folding is reserved for Telegram's hard message limit rather than an arbitrary step count.
- Each turn selects one spinner/completion verb pair from a fixed Claude-style allowlist by stable session/prompt identity. The pair never comes from model text or tool output and never changes while the bubble is alive.
- The official Channel owns the initial typing action. The renderer owns sustained two-second refresh and cancels before final delivery, turn closure, supersession, rejection, or a ten-minute dead-man cutoff.
- Typed `StopFailure.error` is the primary runtime-failure surface. Every bound turn also watches only its exact secure transcript append for at most five seconds because Claude Code 2.1.241 can represent background quota exhaustion as a failed task notification followed by an `isApiErrorMessage` row without firing StopFailure. The fallback accepts only the fixed error enum plus a bounded integer `quotaLimits.resetsAt`; provider prose, `error_details`, and task summaries never enter Telegram. When typed `rate_limit` lacks reset metadata, the renderer may read only the private, owner-bound, mode-0600 `statusLine.rate_limits` snapshot; it enriches the notice only from an exactly exhausted, future-reset window, uses the latest reset if several windows are exhausted, and otherwise keeps the generic text. Normal Stop/supersession cancels the watcher.
- Typed rate-limit StopFailure waits at most 250 ms for the exact transcript watcher so structured reset metadata wins; timeout falls back to the typed fixed notice. The shared parser accepts only known quota metadata keys and never forwards provider prose.
- Runtime-failure notices reserve one `chat + error` incident before transport, remain deduped for at least five minutes or through a trusted reset time no more than seven days ahead, and never retry an unknown send. No credential preflight, second Telegram poller, persistent transcript tail, or model-generated outage text belongs to this rail.
- Under active structured quota, `/usage` never renders local snapshot percentages. Optional `CLAUDE_OAUTH_USAGE_ENABLED=true` permits one read-only on-demand OAuth usage GET with a 120-second success cache and five-minute failure cooldown; credentials are owner-bound mode-0600, never refreshed or written, and failure/429 shows reached/reset when known or `Live usage unavailable` otherwise.
- During a future structured quota window, the activation-attested queue sidecar reserves each later ordinary Telegram message before transport and sends the same quoted fixed notice with reset time. `/usage` remains a separate control path; mutation controls never enter quota takeover.
- A direct Telegram envelope and live allowlist bind the turn. Missing or malformed binding suppresses disclosure.
- A fixed `PostToolUse:TaskStop` hook forwards only bounded `tool_input.task_id` plus literal `TaskStop` / `killed`; the renderer resolves that ID through the existing exact alias map before terminalizing the owner bubble. This covers killed notifications absorbed by Claude's busy-turn queue without trusting TaskStop prose or output.
- Structured terminal task statuses are bounded to `completed | failed | killed`. After exact route consumption, the route-owned task alias may terminalize its matching agent as `Done | Failed | Stopped`; arbitrary task IDs cannot stop another agent, and terminal summary prose is never rendered.
- A terminal internal background-task notification (`completed`, `failed`, or `killed`) may bind only through an unexpired in-memory route created when the same session's authority-bound turn emitted the exact `tool_use_id`. A fixed PostToolUse launch status plus bounded `agentId` may add a task-id alias to that existing route; it never creates authority alone. Binding consumes that route before transport, so replays cannot create a second final. The recovered turn owns no foreground progress, typing heartbeat, artifact scan, or reaction mutation. If it emits a downstream `Skill`/`Task`/`Agent` tool ID, that exact authority may create bounded descendant routes; only verified downstream `SubagentStart` events can open a new event-driven background bubble after the recovered final. Direct Telegram text that merely contains task-notification markup cannot enter this path.
- Background lifecycle labels come directly from Claude Code's bounded `${agent_type}` value. Child `SubagentStop` events may mark their rows Done, but the bubble header stays `Finalizing…` while the originating background tool route is pending and becomes `Done` only after exact terminal task authority is consumed.
- Background lineage is capped at two routed generations. Retention allows 32 ordinary turns plus 16 active background turns; pending `Finalizing…` parent routes remain active for retention.
- Presentation is fail-open for the agent: hook, send, edit, throttle, and restart failures never block tool execution or the final reply. Progress send/edit attempts have a 500-millisecond abort budget; timeout preserves terminal uncertainty, while canonical final delivery keeps its separate timeout.
- MarkdownV2 conversion parses canonical GFM with single-tilde strikethrough disabled, then escapes literal tildes only at text-node source offsets. Numeric ranges stay literal; `~~strikethrough~~`, code spans, and link destinations retain their syntax.
- Each foreground/background phase owns at most one replacement progress bubble; unknown sends are never retried and 429 ends disclosure for that phase.

## Session continuity

- Telegram Bot Menu registration uses only per-chat `setMyCommands`/`getMyCommands` for positive allowlisted private chats. It never calls `getUpdates`, never acts as authorization, and advertises only commands with deterministic handlers.
- Exact session-control commands are parsed by a UserPromptSubmit hook before the LLM; ordinary messages alone reach the model. An activation-attested `/usage` append rail is the only exception.
- Model switching accepts only fixed aliases, persists only `ANTHROPIC_MODEL` in a root-owned environment file, restarts the existing `--continue` service through the root helper, and verifies the live process environment before reporting completion. It never injects `/model` into the TUI or mutates global Claude settings.
- Model selection buttons use one-time `ReplyKeyboardMarkup`, not inline callbacks. Four exact labels switch models; `5 · Cancel` only removes the keyboard. Bare numeric or plain `Cancel` replies remain ordinary conversation.
- A side-effect-free command hook blocks control namespaces even if the MCP dispatcher is unavailable. Every session-control MCP tool is denied to the model; permissions are the provenance boundary for the mutating dispatcher.
- A numbered list is an atomic, private, ten-minute snapshot. Later session activity never repoints a visible index.
- Session titles prefer the latest native `custom-title` / `ai-title`. When native title generation is absent, the catalog uses only turn metadata to distinguish `Conversation with Claudio` from `Control-only session`; it never derives a title from prompt text.
- A user `custom-title` always outranks every `ai-title`, regardless of JSONL record order. Automatic naming makes at most one Haiku-class call per exact session UUID, stores no prompt/body context, serializes automatic/manual title mutation with a persistent `0600` kernel `flock`, and writes only through the official zero-turn `claude -p "/rename ..." --resume` local-command path with exact readback. `/rename NAME` marks the session `USER_LOCKED` and automatic naming can never overwrite it.
- Automatic naming never runs a model inside the scrubbed hook or MCP child. The Stop hook validates exact session/transcript authority and schedules one fixed Broker Protocol title job, then returns. PID 1 injects only the root-owned OAuth EnvironmentFile into that unit; the root helper allowlists auth, drops to the configured service user, and executes the dedicated title worker. A live forked background task defers naming without claiming title state; a terminal internal Stop is the next trigger. Stop is primary, while `/resume` (and legacy `/sessions`) plus `/reset` are backstops. Failure is display-only and never blocks reply delivery or session control.
- Slash-control UI uses bounded Telegram HTML for hierarchy only—bold titles, italic metadata, and code values—without card-like blocks or unescaped transcript-derived text. Session UUIDs and paths never enter user-facing copy.
- `/usage` is read-only and formats a private service-user-owned snapshot of Claude's documented `statusLine.rate_limits`. It starts no extra Claude process, performs no model/API call, and accepts only bounded 5-hour/7-day windows. The activation-attested session-control sidecar baselines up to 64 secure existing transcript FDs at EOF and polls only their appends; an exact fresh `queue-operation: enqueue` for direct `/usage` may send before UserPromptSubmit. It never opens later-created transcripts, never handles another control, and the hook path becomes block-only while this rail is active. Up to 4096 message claims are retained without eviction; reaching the cap suppresses new sends until restart.
- The model supplies neither control commands nor their arguments. It never receives a confirmation code, index, session UUID, transcript path, helper path, service, unit, or command.
- Reset and resume require an action-bound, latest-per-chat, single-use 60-second confirmation challenge before any mutation.
- Resume stays within one root-configured workspace, revalidates at both privilege levels, and rolls back the previous session on failed health checks.
- Official Telegram plugin 0.0.7 does not include `forward_origin` in Channel metadata. An allowlisted user forwarding text whose entire body is an exact command is indistinguishable from typing it; the second exact confirmation message is the safety boundary.

## Reset

- Reset challenge and acceptance messages are sent by the control plane, quote their triggering commands, and are not generated by the model.
- Once that ACK is confirmed, the control plane best-effort replaces `👀` with `👍` before scheduling; reaction failure never blocks reset.
- Reset requests are durably idempotent by inbound `chat_id + message_id`; receipts expire after 30 days and the private store fails closed at 4096 entries.
- The unprivileged control MCP communicates only with a mode-`0600`, non-root service-user-owned Unix socket. Broker Protocol v2 accepts `capabilities|reset|resume|model|title`; the root broker rejects UID 0, checks `SO_PEERCRED`, limits mutations to 12 per minute and four concurrent helper jobs, and derives every unit, request ID, helper/config/auth path, and fixed no-shell systemd argv.
- The Claude service runs with `NoNewPrivileges=yes` and receives no `sudo`, `systemd-run`, arbitrary D-Bus, executable-path, service-name, or unit-name authority. Human break-glass use of the helper is a separate host-operator path.
- PID 1 owns reset execution before the Claude process is terminated.
- Reset completion and failure notifications remain independent of the original command.
- The root helper is fail-closed: an unreadable or invalid configuration aborts the reset.

## Deployment

- Public source, private credentials, root configuration, and versioned installation remain separate.
- Runtime executes an immutable release directory, never a mutable development checkout.

## Authority

- The renderer and control MCPs reuse the official Channel's token and `access.json` authority.
- They require `dmPolicy: allowlist`, secure `0600` state files, and exact destination membership.
