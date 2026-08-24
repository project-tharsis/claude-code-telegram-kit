#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import type { MemoryReviewProposal } from "@project-tharsis/claude-code-telegram-shared";
import { readMemoryReviewReceipt, transitionMemoryReviewReceipt } from "@project-tharsis/claude-code-telegram-shared";
import { generateMemoryReviewProposal, MemoryReviewGenerationError } from "./memory-review-generator.js";
import type { MemoryReviewSnapshot } from "./memory-review-snapshot.js";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SNAPSHOT_BYTES = 32 * 1024;

export type MemoryReviewWorkerResult =
  | { outcome: "reviewed"; proposal: MemoryReviewProposal }
  | { outcome: "no_op" }
  | { outcome: "failed"; reason: string };

export interface MemoryReviewWorkerOptions {
  sessionId: string;
  promptId: string;
  snapshot: MemoryReviewSnapshot;
  receiptDirectory?: string;
  review?: (snapshot: MemoryReviewSnapshot) => Promise<MemoryReviewProposal>;
}

/**
 * The immutable one-shot reviewer entrypoint. It never touches the transcript, the memory
 * tree, or any file beyond the exact receipt it is bound to: it reads one queued receipt by
 * (session_id, prompt_id), runs one isolated model call against the caller-supplied bounded
 * snapshot, validates the result against the strict proposal schema, and transitions that
 * one receipt to a terminal status. It has no write authority over anything else.
 */
export async function runMemoryReviewWorker(options: MemoryReviewWorkerOptions): Promise<MemoryReviewWorkerResult> {
  if (!SESSION_UUID.test(options.sessionId)) throw new Error("invalid session identity");
  if (!PROMPT_ID_RE.test(options.promptId)) throw new Error("invalid prompt identity");

  const storeOptions = options.receiptDirectory === undefined ? {} : { directory: options.receiptDirectory };
  const receipt = readMemoryReviewReceipt(options.sessionId, options.promptId, storeOptions);
  if (receipt === null || receipt.status !== "queued") {
    throw new Error("no queued review receipt for this session/prompt");
  }

  const review = options.review ?? (snapshot => generateMemoryReviewProposal(snapshot));
  try {
    const proposal = await review(options.snapshot);
    const transitioned = transitionMemoryReviewReceipt(options.sessionId, options.promptId, "reviewed", storeOptions);
    if (!transitioned) throw new Error("review receipt transition failed");
    return proposal.decision === "no_op" ? { outcome: "no_op" } : { outcome: "reviewed", proposal };
  } catch (error) {
    transitionMemoryReviewReceipt(options.sessionId, options.promptId, "failed", storeOptions);
    const reason = error instanceof MemoryReviewGenerationError ? `${error.phase}:${error.reason}` : "unknown";
    return { outcome: "failed", reason };
  }
}

interface WorkerStdin {
  snapshot: MemoryReviewSnapshot;
}

function readSnapshotFromStdin(): MemoryReviewSnapshot {
  const raw = readFileSync(0);
  if (raw.byteLength === 0 || raw.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("invalid snapshot input");
  const parsed = JSON.parse(raw.toString("utf8")) as WorkerStdin;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.snapshot !== "object") {
    throw new Error("invalid snapshot input");
  }
  return parsed.snapshot;
}

if (import.meta.main) {
  (async () => {
    try {
      const sessionId = process.argv[2];
      const promptId = process.argv[3];
      if (process.argv.length !== 4 || typeof sessionId !== "string" || typeof promptId !== "string") {
        throw new Error("exactly one session ID and one prompt ID are required");
      }
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error("authenticated review source is unavailable");
      }
      const snapshot = readSnapshotFromStdin();
      const result = await runMemoryReviewWorker({ sessionId, promptId, snapshot });
      if (result.outcome === "failed") throw new Error(`memory review failed: ${result.reason}`);
    } catch {
      process.exitCode = 1;
    }
  })();
}
