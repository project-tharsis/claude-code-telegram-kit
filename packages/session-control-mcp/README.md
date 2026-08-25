# Session Control MCP

An MCP front end for model switching, resetting, listing, and resuming sessions for one Telegram-connected Claude Code workspace.

## Hook tool

```text
dispatch_command(session_id, prompt_id, prompt, hook_event_name="UserPromptSubmit")
```

`dispatch_command` is wired as a denied-to-the-model `UserPromptSubmit` `mcp_tool` hook. It deterministically parses direct Telegram control commands before the LLM: ordinary messages pass through, while `/usage`, `/resume`, `/resume N`, `/model`, `/model opus|sonnet|haiku|inherit`, `/rename NAME`, `/reset`, legacy `/sessions`, and confirmation commands are handled and returned with `decision: block`. In a root activation-attested generation, `/usage` delivery is instead owned by the append rail below; the hook only blocks it.

An independent, side-effect-free command hook (`claude-control-command-guard`) returns the same block decision for control namespaces. It does not depend on MCP readiness, so a timeout or MCP restart cannot leak a control command into the LLM. Only `dispatch_command` performs listing, challenge delivery, or scheduling.

The server advertises only `dispatch_command`. Legacy model-callable reset, bind, list, and resume tools are removed; exact control commands never rely on model tool selection.

`/usage` defaults to a private service-user-owned cache written from Claude's documented `statusLine.rate_limits`; it starts no extra Claude process and calls no LLM. Delivery uses Telegram-safe HTML with bold percentages, reset timestamps, and a compact ten-cell micro-bar. `/resume` sends up to ten numbered titles and stores the UUID mapping in a private, atomic ten-minute snapshot; `/sessions` remains a compatibility alias. `/reset` and `/resume N` issue an action-bound, latest-per-chat, single-use 60-second confirmation code. The confirmation command carries no index or UUID; resume resolves the privately stored index through the snapshot. The model never receives or supplies a confirmation code, session index, session UUID, transcript path, unit, service, helper path, or command.

The descriptor-pinned append rail also restores structured future quota state and acknowledges later ordinary messages with a fixed quoted reset notice. It never parses failed-task summary prose. During active quota, local snapshot percentages are hidden. `CLAUDE_OAUTH_USAGE_ENABLED=true` opts into one read-only OAuth usage request per `/usage`; success may render realtime bars; failure may fall back only to a statusLine snapshot no more than 15 minutes old, always labeled with capture time, while older snapshots render reached/reset when known or `Live usage unavailable`. Enabling requires a current `claude-code/<version>` user agent.

## Control-plane order

1. The official Channel remains the only Telegram poller. In an activation-attested runtime, the session-control MCP baselines secure existing transcript descriptors at EOF and polls only their appended bytes for exact fresh `/usage` enqueue rows; no other control is accepted there.
2. Validate the exact direct envelope, live allowlist, command grammar, transcript/session binding, and five-minute event freshness. Reserve the message before outbound send; unknown outcomes are never retried. The later UserPromptSubmit hook only blocks `/usage`, preventing duplicate delivery.
3. Other controls continue through the UserPromptSubmit dispatcher hook.
4. `/reset` or `/resume N` sends a quoted 60-second confirmation challenge and performs no mutation.
5. The exact action-bound confirmation consumes the challenge once; replay, wrong action, wrong code, and expiry fail closed.
6. Send a quoted acceptance message, then submit one bounded Broker Protocol v2 JSON line over the private Unix socket. Reset and resume both carry the exact current session UUID; root never guesses rollback authority from transcript mtimes.
7. The peer-UID-checking root broker derives the request ID, unit, helper/config paths, and fixed `systemd-run --no-block` argv; the root-owned helper verifies the exact runtime and reports completion or failure independently.

The MCP does not accept command, path, unit, service, or helper arguments from the model.

## Runtime configuration

The MCP reads:

```text
CLAUDE_SESSION_CONTROL_SOCKET
CLAUDE_PROJECT_SESSIONS_DIR
CLAUDE_WORKSPACE_DIR
CLAUDE_SETTINGS_PATH
MEMORY_OBSERVER_ENABLED
TELEGRAM_COMMAND_MENU_ENABLED
CLAUDE_OAUTH_USAGE_ENABLED
CLAUDE_OAUTH_USAGE_USER_AGENT
```

`CLAUDE_OAUTH_USAGE_USER_AGENT` is required when OAuth usage is enabled and must use the current `claude-code/<version>` form. The OAuth adapter never refreshes or writes credentials.

Defaults are documented in `src/runtime.ts` and `src/model-status.ts`. `CLAUDE_PROJECT_SESSIONS_DIR` has no default: listing returns no sessions until one fixed project directory is configured. Model status always reads the fixed root-owned, mode-`0644`, single-line `/etc/claude-code-telegram-kit/model.env` that the service loads through an optional `EnvironmentFile=` directive. The root helper reads a root-owned JSON configuration. See `examples/reset.json`.

Before each confirmed privileged action, the control MCP asks the broker for its read-only capabilities with a five-second socket deadline and requires Broker Protocol v2 plus Session Control Protocol v6 with `reset`, `resume`, `model`, and `title` and the fixed model allowlist. Version skew or an unavailable broker/helper fails before acceptance delivery while read-only status/listing and rendering remain available; a repaired path is detected on the next action without restarting the MCP. The unprivileged process never receives helper/config/systemd/auth paths and never executes `sudo` or `systemd-run`.

By default, the shared authority requires exactly one allowlisted chat. Multi-chat deployments must opt in with `TELEGRAM_ALLOW_MULTIPLE_CHATS=true` in both MCP server environments and `allow_multiple_chats: true` in the root config.

Set `TELEGRAM_COMMAND_MENU_ENABLED=true` to install and read back a chat-specific Telegram Bot Menu for each positive allowlisted private-chat ID. The scope contains `/start`, `/help`, `/status`, `/usage`, `/resume`, `/model`, and `/reset`. It outranks the official Channel's `all_private_chats` menu without modifying that plugin. Menu sync is outbound-only and fail-soft; command authorization remains the live allowlist plus deterministic parser. Bare `/resume` lists sessions; `/resume N` carries the selected index. Before removing a chat from the allowlist or disabling the feature, set the value to `delete`, restart once, and require an empty `getMyCommands` readback for that chat scope; then remove the chat or env key.

`/model` sends a compact 2×2 one-time model keyboard plus `5 · Cancel`. Telegram sends a selected label back as ordinary `message:text`, so the official Channel remains the sole poller. The four numbered model labels switch through the deterministic path; `5 · Cancel` sends no helper request and only removes the keyboard. Bare numbers, model names, and plain `Cancel` remain ordinary conversation.

Control replies use Telegram HTML sparingly for mobile hierarchy: bold headings, italic state/help text, and code-formatted commands or model values. `/resume` escapes every native title and never displays UUIDs/paths; `/sessions` remains a compatibility alias. If Claude Code did not emit a native title, the catalog shows `Conversation with Claudio` for a real model-backed session or `Control-only session` otherwise; it never infers a title from prompt content.

After the first meaningful Stop, the command hook only validates exact session/transcript authority and schedules a fixed broker title job. PID 1 injects the root-owned OAuth EnvironmentFile into that one-shot unit; the root helper passes only allowlisted auth to a dedicated service-user worker. The worker extracts only the first bounded Telegram prompt, first bounded assistant text, and tool names; raw tool inputs/outputs are excluded. It makes at most two isolated `haiku` calls for that exact UUID only when the first generation/parse failure is proven retryable, validates a 60-character title, then uses the official zero-turn `claude -p "/rename ..." --resume` local-command path and exact readback to persist `custom-title`. Private `0600` state and persistent kernel-`flock` files under `~/.local/state/claude-code-telegram-kit/session-titles/` enforce cross-process singleflight and provenance. `/rename NAME` is deterministic, private-chat only, uses zero model calls, and permanently locks the user title above native/automatic titles.

The helper stores root-owned idempotency receipts under `/var/lib/claude-code-telegram-kit/reset-requests/`. Receipts expire after 30 days. The store is capped at 4096 entries and fails closed when full.

## Memory Harness read-only isolation spike (PR 1)

A `Stop` command hook (`memory-review-command.ts`) reads `MEMORY_REVIEW_ENABLED` and, on the
production default of unset/anything other than the exact string `true`, returns immediately
without creating a receipt, contacting the broker, or making a model call. When explicitly
enabled it evaluates the verified-delivery trigger, creates a durable `0700`/`0600`,
singleflight-by-`(session_id, prompt_id)` review receipt under
`~/.local/state/claude-code-telegram-kit/memory-review/receipts/`, and schedules a fixed
`memory-review` broker action mirroring the `title` action exactly: the same root-owned OAuth
`EnvironmentFile` injection, the same `systemd-run --collect --no-block` argv derivation, and
no caller-selected path/argv/env. The dispatched worker is the checked-in, byte-verified
bundle at `dist/memory-review-worker.js`, executed through the same pinned-Bun-FD pattern as
the title worker: no `--channels`, no `--resume`/session fork, `--no-session-persistence`,
`--setting-sources ""`, no MCP servers, no Bash/Read/Edit/Write tools, one bounded turn, one
bounded output. The reviewer only ever emits the strict `{decision, target, topic, evidence,
content, reason, freshness}` proposal shape; any out-of-schema field, overlong string,
path-like value, credential-shaped content, or unsupported target is rejected before the
worker transitions its bound receipt out of `queued`. This PR performs no memory mutation:
the worker never has write authority over anything but its own bound receipt's status field.

## Native memory observer and provenance ledger (PR 2)

`memory-observer-command.ts` is a `SessionStart(startup)` preflight guarded by
`MEMORY_OBSERVER_ENABLED` (production default disabled). When enabled, it reads the exact settings
file named by `CLAUDE_SETTINGS_PATH`, requires one explicit absolute `autoMemoryDirectory`, and
opens that existing directory without creating or mutating it. The observer inventories only
bounded top-level Markdown leaves. Every directory and file is descriptor-pinned and checked for
owner, symlinks, link count, writable permissions, file count, and byte caps before content hashes
are returned. Memory bodies are never persisted.

The independent ledger at
`~/.local/state/claude-code-telegram-kit/memory-observer/ledger.json` stores only sorted metadata,
SHA-256 watermarks, release provenance, and bounded `created` / `modified` / `deleted` events. It
uses an atomic `0700` directory and `0600` single-link file, exact readback, 30-day retention, and a
2,048-event cap. Corrupt JSON is rebuilt from a fresh read-only observation and marked as recovered;
unsafe filesystem leaves fail closed. The ledger path is rejected if it is inside native memory.
A failed startup preflight leaves no fresh ready ledger, so later review/apply stages must remain
disabled rather than deriving Claude's internal fallback path.

## Installing root assets

The user-level deploy script never installs privileged files. After reviewing and merging one exact commit, run the installer from that same checkout. The installer refuses non-SHA refs, verifies its own bytes against the exact Git object, renders the socket owner, backs up every destination, installs atomically, and reads back mode/owner/SHA-256:

```bash
SHA=<exact-40-char-merge-sha>
SERVICE_USER=USER
sudo python3 scripts/install_root_assets.py install \
  --repo . \
  --commit "$SHA" \
  --service-user "$SERVICE_USER"
sudo python3 -c 'import json; p="/var/lib/claude-code-telegram-kit/root-assets/installed.json"; d=json.load(open(p)); print(d["commit"], len(d["assets"]))'
/usr/local/sbin/claude-code-session-reset --capabilities
sudo systemctl daemon-reload
sudo systemctl enable --now claude-code-control.socket
sudo systemctl restart claude-telegram.service
systemctl is-active claude-telegram.service
```

The socket must read back as mode `0600` and owned by a non-root service user. The broker permits at most 12 mutations per minute and four concurrent helper jobs. Never grant the service user `sudo`, `systemd-run`, arbitrary D-Bus, or a writable broker/helper/unit path. To restore the previous root-owned assets, run `sudo python3 scripts/install_root_assets.py rollback`, then `systemctl daemon-reload` and restart the Claude service.

Never bypass the installer's self-verification or invoke privileged asset installation from a user-writable `current` symlink.

## Local recovery

The local helper remains available when the bot or model is unavailable:

```bash
sudo claude-code-session-reset \
  --config /etc/claude-code-telegram-kit/reset.json \
  --action reset \
  --current-session-id <exact-current-session-uuid>
```
