/** Secure state and directory-FD primitives for the dormant native-memory applier. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { openDirectoryFd } from "./fs-safety.js";

const FILE_MODE = 0o600;
const MAX_MEMORY_FILE_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 512 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MEMORY_NAME_RE = /^(?:MEMORY|[a-z][a-z0-9]*(?:-[a-z0-9]+)?)\.md$/;
const JOURNAL_NAME_RE = /^[0-9a-f]{64}\.apply\.json$/;
export const MANAGED_LEDGER_NAME = "managed-ownership.json";

export interface MemoryLeafImage {
  path: string;
  exists: boolean;
  sha256: string | null;
  mode: number | null;
  dev: number | null;
  ino: number | null;
  mtime_ns: string | null;
  bytes_b64: string | null;
}

export interface MemoryManagedLedgerEntry {
  path: string;
  owner: "memory_review_applier";
  sha256: string;
  proposal_key: string;
  updated_at: number;
}

export interface MemoryManagedLedger {
  schema: 1;
  entries: MemoryManagedLedgerEntry[];
}

export type MemoryApplyPhase =
  | "prepared"
  | "topic_applied"
  | "index_applied"
  | "ledger_applied"
  | "committed";

export interface MemoryApplyJournalFile {
  before: MemoryLeafImage;
  after_sha256: string;
  after_b64: string;
}

export interface MemoryApplyJournal {
  schema: 1;
  proposal_key: string;
  session_id: string;
  prompt_id: string;
  release_sha: string;
  directory_sha256: string;
  memory_directory: string;
  phase: MemoryApplyPhase;
  files: MemoryApplyJournalFile[];
  ledger_before_b64: string | null;
  ledger_before_sha256: string | null;
  ledger_after_sha256: string;
  created_at: number;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short applier write");
    offset += count;
  }
}

function readAll(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("short applier read");
    offset += count;
  }
  return bytes;
}

function decodeBase64Strict(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid applier base64");
  return bytes;
}

function validateMemoryName(name: string): void {
  if (!MEMORY_NAME_RE.test(name)) throw new Error("unsafe managed memory path");
}

function missingImage(name: string): MemoryLeafImage {
  return {
    path: name,
    exists: false,
    sha256: null,
    mode: null,
    dev: null,
    ino: null,
    mtime_ns: null,
    bytes_b64: null,
  };
}

export function captureMemoryLeaf(
  rootfd: number,
  name: string,
  expectedUid: number | undefined = uid(),
): MemoryLeafImage {
  validateMemoryName(name);
  const path = `/proc/self/fd/${rootfd}/${name}`;
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingImage(name);
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (before.mode & 0o22n) !== 0n ||
    (expectedUid !== undefined && before.uid !== BigInt(expectedUid)) ||
    before.size > BigInt(MAX_MEMORY_FILE_BYTES)
  ) {
    throw new Error("unsafe memory file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1n ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.size !== before.size
    ) {
      throw new Error("memory file changed during open");
    }
    const bytes = readAll(fd, Number(opened.size));
    const after = fstatSync(fd, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.nlink !== opened.nlink ||
      after.mode !== opened.mode ||
      after.uid !== opened.uid ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs
    ) {
      throw new Error("memory file changed during read");
    }
    return {
      path: name,
      exists: true,
      sha256: sha256(bytes),
      mode: Number(opened.mode & 0o7777n),
      dev: Number(opened.dev),
      ino: Number(opened.ino),
      mtime_ns: opened.mtimeNs.toString(),
      bytes_b64: bytes.toString("base64"),
    };
  } finally {
    closeSync(fd);
  }
}

export function sameMemoryImage(left: MemoryLeafImage, right: MemoryLeafImage): boolean {
  if (left.path !== right.path || left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return (
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtime_ns === right.mtime_ns
  );
}

export function writeMemoryLeafCas(
  rootfd: number,
  before: MemoryLeafImage,
  bytes: Buffer,
  expectedUid: number | undefined = uid(),
): MemoryLeafImage {
  if (bytes.byteLength > MAX_MEMORY_FILE_BYTES) throw new Error("memory file exceeds size limit");
  validateMemoryName(before.path);
  const anchored = `/proc/self/fd/${rootfd}`;
  const target = join(anchored, before.path);
  const tempName = `.memory-apply.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const temp = join(anchored, tempName);
  const mode = before.mode ?? 0o644;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  const current = captureMemoryLeaf(rootfd, before.path, expectedUid);
  if (!sameMemoryImage(current, before)) {
    unlinkSync(temp);
    throw new Error("memory CAS mismatch");
  }
  renameSync(temp, target);
  fsyncSync(rootfd);
  const written = captureMemoryLeaf(rootfd, before.path, expectedUid);
  if (!written.exists || written.sha256 !== sha256(bytes)) throw new Error("memory write readback failed");
  return written;
}

export function removeMemoryLeafCas(
  rootfd: number,
  expected: MemoryLeafImage,
  expectedUid: number | undefined = uid(),
): void {
  if (!expected.exists) return;
  const current = captureMemoryLeaf(rootfd, expected.path, expectedUid);
  if (!sameMemoryImage(current, expected)) throw new Error("memory CAS mismatch");
  unlinkSync(`/proc/self/fd/${rootfd}/${expected.path}`);
  fsyncSync(rootfd);
}

function validateLedger(value: unknown): MemoryManagedLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid managed ledger");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.schema !== 1 || !Array.isArray(record.entries)) {
    throw new Error("invalid managed ledger");
  }
  const entries: MemoryManagedLedgerEntry[] = record.entries.map(value => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid managed ledger");
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 5 ||
      typeof entry.path !== "string" ||
      !MEMORY_NAME_RE.test(entry.path) ||
      entry.path === "MEMORY.md" ||
      entry.owner !== "memory_review_applier" ||
      typeof entry.sha256 !== "string" ||
      !SHA256_RE.test(entry.sha256) ||
      typeof entry.proposal_key !== "string" ||
      !SHA256_RE.test(entry.proposal_key) ||
      !Number.isSafeInteger(entry.updated_at) ||
      Number(entry.updated_at) < 0
    ) {
      throw new Error("invalid managed ledger");
    }
    return {
      path: entry.path,
      owner: "memory_review_applier",
      sha256: entry.sha256,
      proposal_key: entry.proposal_key,
      updated_at: Number(entry.updated_at),
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path >= entries[index]!.path) throw new Error("invalid managed ledger ordering");
  }
  return { schema: 1, entries };
}

function readStateBytes(dirfd: number, name: string): Buffer | null {
  const path = `/proc/self/fd/${dirfd}/${name}`;
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== FILE_MODE ||
    before.size < 1 ||
    before.size > MAX_STATE_BYTES ||
    (uid() !== undefined && before.uid !== uid())
  ) {
    throw new Error("unsafe applier state file");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      (opened.mode & 0o7777) !== FILE_MODE ||
      (uid() !== undefined && opened.uid !== uid())
    ) {
      throw new Error("unsafe applier state file");
    }
    return readAll(fd, opened.size);
  } finally {
    closeSync(fd);
  }
}

function writeStateBytes(dirfd: number, name: string, bytes: Buffer): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_STATE_BYTES) throw new Error("applier state exceeds limit");
  const anchored = `/proc/self/fd/${dirfd}`;
  const temp = join(anchored, `.apply-state.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const target = join(anchored, name);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncSync(dirfd);
  const readback = readStateBytes(dirfd, name);
  if (readback === null || !readback.equals(bytes)) throw new Error("applier state readback failed");
}

export function openApplierStateDirectory(path: string): number {
  return openDirectoryFd(path, uid(), 0o700, "memory applier state directory");
}

export function readManagedLedgerFd(dirfd: number): MemoryManagedLedger | null {
  const bytes = readStateBytes(dirfd, MANAGED_LEDGER_NAME);
  if (bytes === null) return null;
  return validateLedger(JSON.parse(bytes.toString("utf8")));
}

export function serializeManagedLedger(ledger: MemoryManagedLedger): Buffer {
  return Buffer.from(JSON.stringify(validateLedger(ledger)), "utf8");
}

export function writeManagedLedgerFd(dirfd: number, ledger: MemoryManagedLedger): void {
  writeStateBytes(dirfd, MANAGED_LEDGER_NAME, serializeManagedLedger(ledger));
}

export function readManagedLedgerBytesFd(dirfd: number): Buffer | null {
  return readStateBytes(dirfd, MANAGED_LEDGER_NAME);
}

export function restoreManagedLedgerFd(
  dirfd: number,
  beforeBytes: Buffer | null,
  afterSha256: string,
): "restored" | "already" | "conflict" {
  const current = readStateBytes(dirfd, MANAGED_LEDGER_NAME);
  const currentHash = stateBytesHash(current);
  const beforeHash = stateBytesHash(beforeBytes);
  if (currentHash === beforeHash) return "already";
  if (currentHash !== afterSha256) return "conflict";
  if (beforeBytes === null) {
    try {
      unlinkSync(`/proc/self/fd/${dirfd}/${MANAGED_LEDGER_NAME}`);
      fsyncSync(dirfd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else {
    validateLedger(JSON.parse(beforeBytes.toString("utf8")));
    writeStateBytes(dirfd, MANAGED_LEDGER_NAME, beforeBytes);
  }
  return "restored";
}

function validateImage(value: unknown): MemoryLeafImage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid applier journal image");
  const image = value as Record<string, unknown>;
  if (
    Object.keys(image).length !== 8 ||
    typeof image.path !== "string" ||
    !MEMORY_NAME_RE.test(image.path) ||
    typeof image.exists !== "boolean"
  ) throw new Error("invalid applier journal image");
  if (!image.exists) {
    if ([image.sha256, image.mode, image.dev, image.ino, image.mtime_ns, image.bytes_b64].some(item => item !== null)) {
      throw new Error("invalid applier journal image");
    }
  } else if (
    typeof image.sha256 !== "string" ||
    !SHA256_RE.test(image.sha256) ||
    !Number.isSafeInteger(image.mode) ||
    !Number.isSafeInteger(image.dev) ||
    !Number.isSafeInteger(image.ino) ||
    typeof image.mtime_ns !== "string" ||
    !/^\d+$/.test(image.mtime_ns) ||
    typeof image.bytes_b64 !== "string" ||
    sha256(decodeBase64Strict(image.bytes_b64)) !== image.sha256
  ) throw new Error("invalid applier journal image");
  return image as unknown as MemoryLeafImage;
}

function validateJournal(value: unknown): MemoryApplyJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid applier journal");
  const journal = value as Record<string, unknown>;
  const phases: MemoryApplyPhase[] = ["prepared", "topic_applied", "index_applied", "ledger_applied", "committed"];
  if (
    Object.keys(journal).length !== 13 ||
    journal.schema !== 1 ||
    typeof journal.proposal_key !== "string" ||
    !SHA256_RE.test(journal.proposal_key) ||
    typeof journal.session_id !== "string" ||
    !SESSION_RE.test(journal.session_id) ||
    typeof journal.prompt_id !== "string" ||
    !PROMPT_RE.test(journal.prompt_id) ||
    typeof journal.release_sha !== "string" ||
    !RELEASE_SHA_RE.test(journal.release_sha) ||
    typeof journal.directory_sha256 !== "string" ||
    !SHA256_RE.test(journal.directory_sha256) ||
    typeof journal.memory_directory !== "string" ||
    !isAbsolute(journal.memory_directory) ||
    resolve(journal.memory_directory) !== journal.memory_directory ||
    typeof journal.phase !== "string" ||
    !phases.includes(journal.phase as MemoryApplyPhase) ||
    !Array.isArray(journal.files) ||
    journal.files.length < 1 ||
    journal.files.length > 2 ||
    typeof journal.ledger_after_sha256 !== "string" ||
    !SHA256_RE.test(journal.ledger_after_sha256) ||
    !Number.isSafeInteger(journal.created_at)
  ) throw new Error("invalid applier journal");
  const files: MemoryApplyJournalFile[] = journal.files.map(value => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid applier journal");
    const file = value as Record<string, unknown>;
    if (
      Object.keys(file).length !== 3 ||
      typeof file.after_sha256 !== "string" ||
      !SHA256_RE.test(file.after_sha256) ||
      typeof file.after_b64 !== "string" ||
      sha256(decodeBase64Strict(file.after_b64)) !== file.after_sha256
    ) throw new Error("invalid applier journal");
    return {
      before: validateImage(file.before),
      after_sha256: file.after_sha256,
      after_b64: file.after_b64,
    };
  });
  if (
    (journal.ledger_before_b64 !== null && typeof journal.ledger_before_b64 !== "string") ||
    (journal.ledger_before_sha256 !== null &&
      (typeof journal.ledger_before_sha256 !== "string" || !SHA256_RE.test(journal.ledger_before_sha256))) ||
    (journal.ledger_before_b64 === null) !== (journal.ledger_before_sha256 === null) ||
    (typeof journal.ledger_before_b64 === "string" &&
      sha256(decodeBase64Strict(journal.ledger_before_b64)) !== journal.ledger_before_sha256)
  ) throw new Error("invalid applier journal ledger backup");
  return { ...(journal as unknown as MemoryApplyJournal), files };
}

export function journalName(proposalKey: string): string {
  if (!SHA256_RE.test(proposalKey)) throw new Error("invalid proposal key");
  return `${proposalKey}.apply.json`;
}

export function readJournalFd(dirfd: number, name: string): MemoryApplyJournal | null {
  if (!JOURNAL_NAME_RE.test(name)) throw new Error("invalid applier journal name");
  const bytes = readStateBytes(dirfd, name);
  if (bytes === null) return null;
  return validateJournal(JSON.parse(bytes.toString("utf8")));
}

export function writeJournalFd(dirfd: number, journal: MemoryApplyJournal): void {
  const validated = validateJournal(journal);
  writeStateBytes(dirfd, journalName(validated.proposal_key), Buffer.from(JSON.stringify(validated), "utf8"));
}

export function removeJournalFd(dirfd: number, name: string): void {
  if (!JOURNAL_NAME_RE.test(name)) throw new Error("invalid applier journal name");
  try {
    unlinkSync(`/proc/self/fd/${dirfd}/${name}`);
    fsyncSync(dirfd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function listJournalNamesFd(dirfd: number): string[] {
  return readdirSync(`/proc/self/fd/${dirfd}`).filter(name => JOURNAL_NAME_RE.test(name)).sort();
}

export function imageBytes(image: MemoryLeafImage): Buffer {
  if (!image.exists || image.bytes_b64 === null) throw new Error("missing memory image bytes");
  return decodeBase64Strict(image.bytes_b64);
}

export function stateBytesHash(bytes: Buffer | null): string | null {
  return bytes === null ? null : sha256(bytes);
}

export function bytesHash(bytes: Buffer): string {
  return sha256(bytes);
}
