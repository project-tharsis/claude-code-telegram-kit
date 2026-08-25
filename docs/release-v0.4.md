# v0.4 release preparation

This document prepares v0.4.0 artifacts. It does **not** create a Git tag or GitHub Release.

## Scope

- Native Claude auto-memory observer and bounded provenance ledger.
- Verified-delivery review triggers and strict isolated proposal generation.
- Managed-topic apply with Stop idle proof, journaled rollback, and one-shot learning delta.
- Claude compatibility floor and process-tree timeout hardening.

## Required gates

- `bun run check` passes from the exact final tree.
- Python 3.11 and 3.12 CI pass on the exact PR head.
- Four package versions, three workspace lock entries, and both MCP identities are `0.4.0`.
- Checked-in isolated bundles match source byte-for-byte.
- Public-tree privacy scan and dependency audit pass.

## Production defaults

`MEMORY_REVIEW_ENABLED`, `MEMORY_OBSERVER_ENABLED`, `MEMORY_APPLY_ENABLED`, and `MEMORY_LEARNING_DELTA_ENABLED` stay disabled unless activation explicitly enables them.

## Activation prerequisites

- Exact configured `autoMemoryDirectory` exists and passes read-only inventory.
- Installed Claude Code meets the `2.1.196` floor.
- One private captured Stop payload validates `prompt_id`, `stop_hook_active`, `background_tasks`, and `session_crons`.
- Root assets are installed from the same exact merge SHA before root activation.
- Activation readback proves one poller, renderer, and session-control worker on that SHA.

Tagging and GitHub Release publication remain a separate explicit human action.
