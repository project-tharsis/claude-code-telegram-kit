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
  type RuntimeConfig
} from "@project-tharsis/claude-code-telegram-shared";
import type { ArtifactCandidate } from "./progress-disclosure.js";

export const MAX_ARTIFACTS_PER_TURN = 4;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 100 * 1024 * 1024;
const ARTIFACT_TIMEOUT_BASE_MS = 15_000;
const ARTIFACT_TIMEOUT_PER_MIB_MS = 5_000;
const MAX_ARTIFACT_TIMEOUT_MS = 5 * 60_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ArtifactFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ArtifactDeliveryOutcome =
  | { kind: "success"; messageIds: number[] }
  | { kind: "permanent"; messageIds: number[] }
  | { kind: "uncertain"; messageIds: number[] }
  | { kind: "local_rejected"; messageIds: number[] };

interface LoadedArtifact {
  bytes: Uint8Array<ArrayBuffer>;
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

function readBounded(fd: number, expectedSize: number, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (expectedSize > maxBytes) throw new Error("artifact exceeds the size limit");
  const result = new Uint8Array(expectedSize);
  let total = 0;
  while (total < expectedSize) {
    const count = readSync(fd, result, total, expectedSize - total, null);
    if (count === 0) throw new Error("artifact changed while reading");
    total += count;
  }
  if (readSync(fd, new Uint8Array(1), 0, 1, null) !== 0) throw new Error("artifact grew while reading");
  return result;
}

export function artifactUploadTimeoutMs(size: number): number {
  const mib = Math.max(1, Math.ceil(size / (1024 * 1024)));
  return Math.min(MAX_ARTIFACT_TIMEOUT_MS, ARTIFACT_TIMEOUT_BASE_MS + mib * ARTIFACT_TIMEOUT_PER_MIB_MS);
}

function openTrustedChildDirectory(parentFd: number, name: string, uid: number): number {
  if (!name || name.includes("/") || name.includes("\0")) throw new Error("invalid artifact directory");
  const anchoredPath = `/proc/self/fd/${parentFd}/${name}`;
  const before = lstatSync(anchoredPath);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o022) !== 0) {
    throw new Error("artifact directory is not trusted");
  }
  const fd = openSync(anchoredPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== uid) {
      throw new Error("artifact directory identity changed");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
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
      if (
        !after.isFile()
        || after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.uid !== uid
        || after.nlink !== 1
        || (after.mode & 0o022) !== 0
        || after.size !== bytes.byteLength
      ) {
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

    const messageIds: number[] = [];
    let root: TrustedRoot;
    try {
      root = openTrustedRoot(options.root, uid);
    } catch {
      return { kind: "local_rejected", messageIds };
    }

    let remaining = maxTotalBytes;
    try {
      for (const candidate of candidates) {
        let artifact: LoadedArtifact;
        try {
          artifact = loadArtifact(candidate, root, uid, Math.min(maxArtifactBytes, remaining));
        } catch {
          return { kind: "local_rejected", messageIds };
        }
        remaining -= artifact.bytes.byteLength;

        const form = new FormData();
        form.set("chat_id", chatId);
        form.set("reply_parameters", JSON.stringify({ message_id: replyTo }));
        form.set("disable_notification", "true");
        form.set("document", new Blob([artifact.bytes], { type: "application/octet-stream" }), artifact.filename);

        let response: Response;
        try {
          response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendDocument`, {
            method: "POST",
            redirect: "error",
            body: form,
            signal: AbortSignal.timeout(artifactUploadTimeoutMs(artifact.bytes.byteLength))
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
    } finally {
      closeSync(root.fd);
    }
  };
}
