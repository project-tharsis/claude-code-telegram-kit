import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  assertAuthorizedChat,
  readTelegramJson,
  TELEGRAM_SEND_TIMEOUT_MS,
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import type { ArtifactCandidate } from "./progress-disclosure.js";

export const MAX_ARTIFACTS_PER_TURN = 4;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 100 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ArtifactFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ArtifactDeliveryOutcome =
  | { kind: "success"; messageIds: number[] }
  | { kind: "permanent"; messageIds: number[] }
  | { kind: "uncertain"; messageIds: number[] }
  | { kind: "local_rejected"; messageIds: number[] };

interface LoadedArtifact {
  bytes: Uint8Array;
  filename: string;
}

interface TrustedRoot {
  fd: number;
  path: string;
}

interface ArtifactEnvelope {
  ok?: unknown;
  result?: { message_id?: unknown };
}

function safeFilename(path: string): string {
  const value = basename(path).normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
    .slice(0, 128);
  return value || "artifact.bin";
}

function trustedAncestor(info: Stats, uid: number): boolean {
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  if (info.uid === uid) return (info.mode & 0o022) === 0;
  if (info.uid !== 0) return false;
  const writable = (info.mode & 0o022) !== 0;
  return !writable || (info.mode & 0o1000) !== 0;
}

function openTrustedRoot(path: string, uid: number): TrustedRoot {
  if (!isAbsolute(path)) throw new Error("artifact root must be absolute");
  const canonical = resolve(path);
  if (canonical !== path || canonical === "/") throw new Error("artifact root is not canonical");

  const components = canonical.split("/").filter(Boolean);
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let index = 0; index < components.length; index += 1) {
      const anchoredPath = `/proc/self/fd/${fd}/${components[index]!}`;
      const before = lstatSync(anchoredPath);
      const final = index === components.length - 1;
      if (final) {
        if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o022) !== 0) {
          throw new Error("artifact root is not trusted");
        }
      } else if (!trustedAncestor(before, uid)) {
        throw new Error("artifact root ancestor is not trusted");
      }

      const next = openSync(anchoredPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = fstatSync(next);
      const valid = opened.dev === before.dev && opened.ino === before.ino
        && (final
          ? opened.isDirectory() && opened.uid === uid && (opened.mode & 0o022) === 0
          : trustedAncestor(opened, uid));
      if (!valid) {
        closeSync(next);
        throw new Error("artifact root identity changed");
      }
      closeSync(fd);
      fd = next;
    }
    return { fd, path: canonical };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readBounded(fd: number, expectedSize: number, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
    const buffer = new Uint8Array(capacity);
    const count = readSync(fd, buffer, 0, capacity, null);
    if (count === 0) break;
    chunks.push(buffer.subarray(0, count));
    total += count;
    if (total > maxBytes) throw new Error("artifact grew beyond the size limit");
  }
  if (total !== expectedSize) throw new Error("artifact changed while reading");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function openTrustedChildDirectory(parentFd: number, name: string, uid: number): number {
  if (!name || name.includes("/") || name.includes("\0")) throw new Error("invalid artifact directory");
  const anchoredPath = `/proc/self/fd/${parentFd}/${name}`;
  const before = lstatSync(anchoredPath);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o022) !== 0) {
    throw new Error("artifact directory is not trusted");
  }
  const fd = openSync(anchoredPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== uid) {
    closeSync(fd);
    throw new Error("artifact directory identity changed");
  }
  return fd;
}

function loadArtifact(
  candidate: ArtifactCandidate,
  root: TrustedRoot,
  uid: number,
  maxBytes: number
): LoadedArtifact {
  const { path, sessionId } = candidate;
  if (!SESSION_ID.test(sessionId) || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("invalid artifact path");
  }
  const filename = basename(path);
  if (path !== join(root.path, sessionId, "scratchpad", filename)) {
    throw new Error("artifact path does not match the bound session scratchpad");
  }

  const sessionFd = openTrustedChildDirectory(root.fd, sessionId, uid);
  const scratchpadFd = (() => {
    try {
      return openTrustedChildDirectory(sessionFd, "scratchpad", uid);
    } finally {
      closeSync(sessionFd);
    }
  })();

  try {
    const anchoredPath = `/proc/self/fd/${scratchpadFd}/${filename}`;
    const before = lstatSync(anchoredPath);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o022) !== 0
      || before.size < 1
      || before.size > Math.min(MAX_ARTIFACT_BYTES, maxBytes)
    ) {
      throw new Error("artifact file is not trusted");
    }

    const fd = openSync(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.uid !== uid
        || opened.nlink !== 1
        || opened.size !== before.size
      ) {
        throw new Error("artifact identity changed");
      }
      const bytes = readBounded(fd, opened.size, Math.min(MAX_ARTIFACT_BYTES, maxBytes));
      const after = fstatSync(fd);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.byteLength) {
        throw new Error("artifact changed while reading");
      }
      return { bytes, filename: safeFilename(filename) };
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(scratchpadFd);
  }
}

function validMessageId(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("invalid reply message ID");
  }
  return parsed;
}

function permanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

export function createArtifactDeliverer(options: {
  root: string;
  fetchImpl?: ArtifactFetchLike;
  uid?: number;
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const uid = options.uid ?? process.getuid?.();
  const maxArtifactBytes = Math.max(1, Math.min(options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES));
  const maxTotalBytes = Math.max(1, Math.min(options.maxTotalBytes ?? MAX_ARTIFACT_TOTAL_BYTES, MAX_ARTIFACT_TOTAL_BYTES));

  return async (
    config: RuntimeConfig,
    chatId: string,
    replyToMessageId: string,
    candidates: readonly ArtifactCandidate[]
  ): Promise<ArtifactDeliveryOutcome> => {
    assertAuthorizedChat(config, chatId);
    if (uid === undefined || candidates.length > MAX_ARTIFACTS_PER_TURN) {
      return { kind: "local_rejected", messageIds: [] };
    }
    if (candidates.length === 0) return { kind: "success", messageIds: [] };

    let replyTo: number;
    try {
      replyTo = validMessageId(replyToMessageId);
    } catch {
      return { kind: "local_rejected", messageIds: [] };
    }

    let loaded: LoadedArtifact[];
    try {
      const root = openTrustedRoot(options.root, uid);
      try {
        loaded = [];
        let remaining = maxTotalBytes;
        for (const candidate of candidates) {
          const artifact = loadArtifact(candidate, root, uid, Math.min(maxArtifactBytes, remaining));
          remaining -= artifact.bytes.byteLength;
          loaded.push(artifact);
        }
      } finally {
        closeSync(root.fd);
      }
    } catch {
      return { kind: "local_rejected", messageIds: [] };
    }

    const messageIds: number[] = [];
    for (const artifact of loaded) {
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("reply_parameters", JSON.stringify({ message_id: replyTo }));
      form.set("disable_notification", "true");
      const document = new ArrayBuffer(artifact.bytes.byteLength);
      new Uint8Array(document).set(artifact.bytes);
      form.set("document", new Blob([document], { type: "application/octet-stream" }), artifact.filename);

      let response: Response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendDocument`, {
          method: "POST",
          redirect: "error",
          body: form,
          signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS)
        });
      } catch {
        return { kind: "uncertain", messageIds };
      }

      let envelope: ArtifactEnvelope;
      try {
        envelope = await readTelegramJson(response) as ArtifactEnvelope;
      } catch {
        return { kind: "uncertain", messageIds };
      }
      const messageId = envelope.result?.message_id;
      if (
        response.ok
        && envelope.ok === true
        && typeof messageId === "number"
        && Number.isSafeInteger(messageId)
        && messageId >= 1
      ) {
        messageIds.push(messageId);
        continue;
      }
      if (permanentStatus(response.status)) return { kind: "permanent", messageIds };
      return { kind: "uncertain", messageIds };
    }
    return { kind: "success", messageIds };
  };
}
