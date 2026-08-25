# PR4 memory applier (dormant)

PR4 contains the deterministic transaction core only. No production hook, scheduler, MCP tool, or reviewer calls `applyMemoryReviewProposal`. The exact `enabled: true` gate is available to tests and a later host-controlled integration; production remains disabled.

## Authority

An apply attempt must bind all of the following:

- a schema-valid immutable proposal record;
- its exact schema-v2 reviewed receipt;
- matching session, prompt, release SHA, assistant digest, snapshot digest, proposal digest, and native-memory watermark;
- a current full native-memory re-observation of the same directory authority;
- a fresh Stop idle proof with `stop_hook_active: false` and both `background_tasks` and `session_crons` present and empty.

The applier acquires a crash-recoverable global claim in the canonical applier-state namespace plus the exact proposal claim. Different proposals sharing that state authority cannot race the shared index or ownership ledger, and no applier can overlap the reviewer for its proposal.

## Mutation contract

- The configured native-memory root must already exist. Every path segment is opened with `O_NOFOLLOW`; the applier never creates the root.
- Memory leaves are user-owned, single-link, non-writable-by-group/other regular files opened through the pinned root directory FD.
- Create is a two-file transaction: write the topic first, then append one deterministic link to `MEMORY.md`. Idempotent replay verifies both the managed topic hash and the exact index link.
- Patch is allowed only for a topic already owned by the managed ownership ledger and whose current hash equals both the ledger and the observation.
- Writes use same-directory temporary files, `fsync`, an immediate descriptor-backed optimistic CAS recheck, atomic rename, directory `fsync`, and exact readback.
- POSIX has no compare-and-replace primitive for an existing pathname. A non-cooperating writer can still race between the final recheck and rename. This core therefore remains dormant until a verified Stop-time idle producer serializes native writes; CAS alone is not claimed to defeat an active writer.
- The journal/ledger/proposal state directories must remain outside native memory.

## Rollback and recovery

Before any native write, a private `0700`/`0600` journal stores exact before bytes, mode, inode identity, hashes, intended after bytes, and ownership-ledger before/after hashes. Journal phases are `prepared`, `topic_applied`, `index_applied`, `ledger_applied`, and `committed`.

Rollback is conditional. A file is restored or removed only when its current hash is either the applier's intended after image or the already-restored before image. If another writer changed bytes after the applier, recovery preserves those external bytes, reports `rollback_conflict`, and keeps the journal for operator inspection. It never "rolls back" by clobbering an unknown state.

`recoverMemoryReviewApplier` requires the caller's configured memory directory and directory digest, the same exact idle proof, and global/proposal claims. A journal cannot redirect recovery to its own selected path. The journal is removed only after every memory leaf and the ownership ledger are back at their before image. No partial write is inferred to be committed.
