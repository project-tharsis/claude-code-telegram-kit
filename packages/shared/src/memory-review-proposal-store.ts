/** Immutable durable proposals produced by the isolated Memory Harness reviewer. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDirectoryFd } from "./fs-safety.js";
import { memoryReviewReceiptKey, PROMPT_ID_RE } from "./memory-review-receipt.js";
import { type MemoryReviewProposal, validateMemoryReviewProposal } from "./memory-review-proposal.js";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BYTES = 16 * 1024;
export const MEMORY_REVIEW_PROPOSAL_MAX_ENTRIES = 2_048;

export interface MemoryReviewProposalRecord {
  schema: 1;
  session_id: string;
  prompt_id: string;
  release_sha: string;
  last_assistant_message_sha256: string;
  native_memory_watermark: string;
  proposal_sha256: string;
  created_at: number;
  proposal: MemoryReviewProposal;
}

export interface CreateMemoryReviewProposalRecordInput {
  sessionId: string;
  promptId: string;
  releaseSha: string;
  lastAssistantMessageSha256: string;
  nativeMemoryWatermark: string;
  proposal: MemoryReviewProposal;
}

export interface MemoryReviewProposalStoreOptions {
  directory?: string;
  expectedUid?: number;
  maxEntries?: number;
  now?: () => number;
}

export function defaultMemoryReviewProposalDirectory(): string {
  return join(homedir(), ".local", "state", "claude-code-telegram-kit", "memory-review", "proposals");
}

export function memoryReviewProposalKey(sessionId: string, promptId: string): string {
  return memoryReviewReceiptKey(sessionId, promptId);
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function processStartTicks(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const ticks = fields[19];
    return typeof ticks === "string" && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function canonicalProposal(proposal: MemoryReviewProposal): MemoryReviewProposal {
  return validateMemoryReviewProposal(proposal);
}

function proposalDigest(proposal: MemoryReviewProposal): string {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

function validateRecord(value: unknown): MemoryReviewProposalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid proposal record");
  const record = value as Record<string, unknown>;
  const allowed = [
    "schema", "session_id", "prompt_id", "release_sha", "last_assistant_message_sha256",
    "native_memory_watermark", "proposal_sha256", "created_at", "proposal"
  ];
  if (Object.keys(record).length !== allowed.length || allowed.some(key => !(key in record)) || record.schema !== 1 ||
      typeof record.session_id !== "string" || !SESSION_UUID.test(record.session_id) ||
      typeof record.prompt_id !== "string" || !PROMPT_ID_RE.test(record.prompt_id) ||
      typeof record.release_sha !== "string" || !RELEASE_SHA_RE.test(record.release_sha) ||
      typeof record.last_assistant_message_sha256 !== "string" || !SHA256_RE.test(record.last_assistant_message_sha256) ||
      typeof record.native_memory_watermark !== "string" || !SHA256_RE.test(record.native_memory_watermark) ||
      typeof record.proposal_sha256 !== "string" || !SHA256_RE.test(record.proposal_sha256) ||
      !Number.isSafeInteger(record.created_at) || Number(record.created_at) < 0) {
    throw new Error("invalid proposal record");
  }
  const proposal = canonicalProposal(record.proposal as MemoryReviewProposal);
  if (proposalDigest(proposal) !== record.proposal_sha256) throw new Error("invalid proposal digest");
  return {
    schema: 1,
    session_id: record.session_id,
    prompt_id: record.prompt_id,
    release_sha: record.release_sha,
    last_assistant_message_sha256: record.last_assistant_message_sha256,
    native_memory_watermark: record.native_memory_watermark,
    proposal_sha256: record.proposal_sha256,
    created_at: Number(record.created_at),
    proposal
  };
}

function readAll(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("short proposal read");
    offset += count;
  }
  return bytes;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw new Error("short proposal write");
    offset += count;
  }
}

function readLeaf(dirfd: number, name: string, expectedUid: number | undefined): MemoryReviewProposalRecord | null {
  const path = join(`/proc/self/fd/${dirfd}`, name);
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      (before.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && before.uid !== expectedUid) ||
      before.size < 2 || before.size > MAX_BYTES) throw new Error("unsafe proposal file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        (opened.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && opened.uid !== expectedUid) ||
        opened.size < 2 || opened.size > MAX_BYTES) throw new Error("unsafe proposal file");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readAll(fd, opened.size).toString("utf8"));
    } catch {
      throw new Error("invalid proposal record");
    }
    return validateRecord(parsed);
  } finally {
    closeSync(fd);
  }
}

function withDirectory<T>(options: MemoryReviewProposalStoreOptions, action: (dirfd: number, uid: number | undefined) => T): T {
  const uid = options.expectedUid ?? currentUid();
  const dirfd = openDirectoryFd(
    resolve(options.directory ?? defaultMemoryReviewProposalDirectory()), uid, DIRECTORY_MODE, "proposal directory"
  );
  try {
    return action(dirfd, uid);
  } finally {
    closeSync(dirfd);
  }
}

interface ProposalClaimRecord {
  schema: 1;
  pid: number;
  start_ticks: string;
}

export type MemoryReviewProposalClaim =
  | { outcome: "claimed"; release: () => void }
  | { outcome: "busy" };

function readClaim(dirfd: number, name: string, expectedUid: number | undefined): { record: ProposalClaimRecord; dev: number; ino: number } {
  const path = join(`/proc/self/fd/${dirfd}`, name);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 256 ||
      (before.mode & 0o7777) !== FILE_MODE || (expectedUid !== undefined && before.uid !== expectedUid)) {
    throw new Error("unsafe proposal claim");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
        opened.size !== before.size || (opened.mode & 0o7777) !== FILE_MODE ||
        (expectedUid !== undefined && opened.uid !== expectedUid)) throw new Error("unsafe proposal claim");
    const parsed: unknown = JSON.parse(readAll(fd, opened.size).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid proposal claim");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || record.schema !== 1 || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1 ||
        typeof record.start_ticks !== "string" || !/^\d+$/.test(record.start_ticks)) throw new Error("invalid proposal claim");
    return { record: record as unknown as ProposalClaimRecord, dev: opened.dev, ino: opened.ino };
  } finally {
    closeSync(fd);
  }
}

export function acquireMemoryReviewProposalClaim(
  sessionId: string,
  promptId: string,
  options: MemoryReviewProposalStoreOptions = {}
): MemoryReviewProposalClaim {
  if (!SESSION_UUID.test(sessionId) || !PROMPT_ID_RE.test(promptId)) throw new Error("invalid proposal claim identity");
  const key = memoryReviewProposalKey(sessionId, promptId);
  if (!KEY_RE.test(key)) throw new Error("invalid proposal claim key");
  const expectedUid = options.expectedUid ?? currentUid();
  const dirfd = openDirectoryFd(
    resolve(options.directory ?? defaultMemoryReviewProposalDirectory()), expectedUid, DIRECTORY_MODE, "proposal directory"
  );
  const name = `${key}.claim`;
  const path = join(`/proc/self/fd/${dirfd}`, name);
  const startTicks = processStartTicks(process.pid);
  if (startTicks === null) {
    closeSync(dirfd);
    throw new Error("proposal claim process identity unavailable");
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number;
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readClaim(dirfd, name, expectedUid);
        if (processStartTicks(existing.record.pid) === existing.record.start_ticks) {
          closeSync(dirfd);
          return { outcome: "busy" };
        }
        const current = lstatSync(path);
        if (current.dev !== existing.dev || current.ino !== existing.ino) throw new Error("proposal claim changed during recovery");
        unlinkSync(path);
        fsyncSync(dirfd);
        continue;
      }
      let identity: ReturnType<typeof fstatSync>;
      try {
        const record: ProposalClaimRecord = { schema: 1, pid: process.pid, start_ticks: startTicks };
        writeAll(fd, Buffer.from(JSON.stringify(record)));
        fsyncSync(fd);
        identity = fstatSync(fd);
      } catch (error) {
        try { unlinkSync(path); } catch { /* best effort */ }
        closeSync(fd);
        throw error;
      }
      closeSync(fd);
      fsyncSync(dirfd);
      let released = false;
      return {
        outcome: "claimed",
        release: () => {
          if (released) return;
          released = true;
          try {
            const current = lstatSync(path);
            if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("proposal claim ownership changed");
            unlinkSync(path);
            fsyncSync(dirfd);
          } finally {
            closeSync(dirfd);
          }
        }
      };
    }
    throw new Error("unable to acquire proposal claim");
  } catch (error) {
    closeSync(dirfd);
    throw error;
  }
}

function sameBinding(existing: MemoryReviewProposalRecord, candidate: MemoryReviewProposalRecord): boolean {
  return existing.session_id === candidate.session_id && existing.prompt_id === candidate.prompt_id &&
    existing.release_sha === candidate.release_sha &&
    existing.last_assistant_message_sha256 === candidate.last_assistant_message_sha256 &&
    existing.native_memory_watermark === candidate.native_memory_watermark &&
    existing.proposal_sha256 === candidate.proposal_sha256;
}

export function createMemoryReviewProposalRecord(
  input: CreateMemoryReviewProposalRecordInput,
  options: MemoryReviewProposalStoreOptions = {}
): { outcome: "created" | "existing"; record: MemoryReviewProposalRecord } {
  if (!SESSION_UUID.test(input.sessionId) || !PROMPT_ID_RE.test(input.promptId) ||
      !RELEASE_SHA_RE.test(input.releaseSha) || !SHA256_RE.test(input.lastAssistantMessageSha256) ||
      !SHA256_RE.test(input.nativeMemoryWatermark)) throw new Error("invalid proposal binding");
  const proposal = canonicalProposal(input.proposal);
  const record: MemoryReviewProposalRecord = {
    schema: 1,
    session_id: input.sessionId,
    prompt_id: input.promptId,
    release_sha: input.releaseSha,
    last_assistant_message_sha256: input.lastAssistantMessageSha256,
    native_memory_watermark: input.nativeMemoryWatermark,
    proposal_sha256: proposalDigest(proposal),
    created_at: (options.now ?? Date.now)(),
    proposal
  };
  validateRecord(record);
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.byteLength > MAX_BYTES) throw new Error("proposal record too large");

  return withDirectory(options, (dirfd, uid) => {
    const maxEntries = options.maxEntries ?? MEMORY_REVIEW_PROPOSAL_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MEMORY_REVIEW_PROPOSAL_MAX_ENTRIES) {
      throw new Error("invalid proposal entry cap");
    }
    const key = memoryReviewProposalKey(input.sessionId, input.promptId);
    if (!KEY_RE.test(key)) throw new Error("invalid proposal key");
    const name = `${key}.json`;
    const path = join(`/proc/self/fd/${dirfd}`, name);
    const existing = readLeaf(dirfd, name, uid);
    if (existing !== null) {
      if (!sameBinding(existing, record)) throw new Error("proposal conflict");
      return { outcome: "existing", record: existing };
    }
    const count = readdirSync(`/proc/self/fd/${dirfd}`).filter(entry => entry.endsWith(".json")).length;
    if (count >= maxEntries) throw new Error("proposal store capacity exceeded");
    let fd: number;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const raced = readLeaf(dirfd, name, uid);
        if (raced !== null && sameBinding(raced, record)) return { outcome: "existing", record: raced };
        throw new Error("proposal conflict");
      }
      throw error;
    }
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } catch (error) {
      try { unlinkSync(path); } catch { /* best effort */ }
      throw error;
    } finally {
      closeSync(fd);
    }
    fsyncSync(dirfd);
    const readback = readLeaf(dirfd, name, uid);
    if (readback === null || !sameBinding(readback, record)) throw new Error("proposal readback failed");
    return { outcome: "created", record: readback };
  });
}

export function readMemoryReviewProposalRecord(
  sessionId: string,
  promptId: string,
  options: MemoryReviewProposalStoreOptions = {}
): MemoryReviewProposalRecord | null {
  if (!SESSION_UUID.test(sessionId) || !PROMPT_ID_RE.test(promptId)) throw new Error("invalid proposal identity");
  const key = memoryReviewProposalKey(sessionId, promptId);
  return withDirectory(options, (dirfd, uid) => readLeaf(dirfd, `${key}.json`, uid));
}
