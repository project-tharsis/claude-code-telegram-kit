import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BindTurnInput } from "./hook-contract.js";
import type { ArtifactCandidate, ArtifactTracker } from "./progress-disclosure.js";

const MAX_APPEND_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 4;
const MAX_DECLARATIONS = 128;
const TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
}

function trustedFile(info: Stats, uid: number): boolean {
  return info.isFile()
    && !info.isSymbolicLink()
    && info.uid === uid
    && info.nlink === 1
    && (info.mode & 0o022) === 0;
}

function sameIdentity(identity: FileIdentity, info: Stats): boolean {
  return info.dev === identity.dev && info.ino === identity.ino && info.uid === identity.uid;
}

function parseArtifactRows(text: string, sessionId: string): ArtifactCandidate[] {
  const pending = new Map<string, ArtifactCandidate>();
  const successful: ArtifactCandidate[] = [];
  const successfulPaths = new Set<string>();
  let declarations = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const message = record.message;
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const envelope = message as Record<string, unknown>;
    const content = envelope.content;
    if (!Array.isArray(content)) continue;

    if (record.type === "assistant" && envelope.role === "assistant") {
      for (const value of content) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const item = value as Record<string, unknown>;
        if (item.type !== "tool_use" || item.name !== "Artifact" || typeof item.id !== "string") continue;
        if (!TOOL_USE_ID.test(item.id) || pending.has(item.id) || declarations >= MAX_DECLARATIONS) continue;
        const input = item.input;
        if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
        const fields = input as Record<string, unknown>;
        const path = fields.file_path;
        const description = fields.description;
        if (
          typeof path !== "string"
          || !path.startsWith("/")
          || path.includes("\0")
          || path.length > 4_096
          || (description !== undefined && (typeof description !== "string" || description.length > 2_048))
        ) continue;
        declarations += 1;
        pending.set(item.id, {
          sessionId,
          path,
          ...(typeof description === "string" && description ? { description } : {})
        });
      }
    }

    if (record.type === "user" && envelope.role === "user") {
      for (const value of content) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const item = value as Record<string, unknown>;
        if (item.type !== "tool_result" || typeof item.tool_use_id !== "string") continue;
        const artifact = pending.get(item.tool_use_id);
        if (artifact === undefined) continue;
        pending.delete(item.tool_use_id);
        if (
          item.is_error !== true
          && successful.length < MAX_ARTIFACTS
          && !successfulPaths.has(artifact.path)
        ) {
          successfulPaths.add(artifact.path);
          successful.push(artifact);
        }
      }
    }
  }
  return successful;
}

export function startArtifactTranscriptTracker(
  input: BindTurnInput,
  options: { expectedRoot: string; uid?: number }
): ArtifactTracker | null {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || input.transcript_path === undefined) return null;
  if (!isAbsolute(options.expectedRoot) || !isAbsolute(input.transcript_path)) return null;
  if (input.transcript_path !== join(options.expectedRoot, `${input.session_id}.jsonl`)) return null;

  let fd: number | undefined;
  let closed = false;
  try {
    const root = lstatSync(options.expectedRoot);
    if (
      !root.isDirectory()
      || root.isSymbolicLink()
      || root.uid !== uid
      || (root.mode & 0o022) !== 0
      || realpathSync.native(options.expectedRoot) !== options.expectedRoot
    ) return null;

    const before = lstatSync(input.transcript_path);
    if (!trustedFile(before, uid)) return null;
    fd = openSync(input.transcript_path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!trustedFile(opened, uid) || opened.dev !== before.dev || opened.ino !== before.ino) {
      closeSync(fd);
      return null;
    }
    const identity: FileIdentity = { dev: opened.dev, ino: opened.ino, uid: opened.uid };
    const offset = opened.size;

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* no-op */ }
        fd = undefined;
      }
    };

    return {
      collect(): ArtifactCandidate[] {
        if (closed || fd === undefined) return [];
        try {
          const current = fstatSync(fd);
          if (!trustedFile(current, uid) || !sameIdentity(identity, current) || current.size < offset) return [];
          const growth = current.size - offset;
          if (growth < 1) return [];
          const readOffset = growth > MAX_APPEND_BYTES ? current.size - MAX_APPEND_BYTES : offset;
          const readLength = current.size - readOffset;
          const bytes = Buffer.alloc(readLength);
          let read = 0;
          while (read < readLength) {
            const count = readSync(fd, bytes, read, readLength - read, readOffset + read);
            if (count <= 0) return [];
            read += count;
          }
          const after = fstatSync(fd);
          if (!trustedFile(after, uid) || !sameIdentity(identity, after) || after.size !== current.size) return [];
          let text = new TextDecoder().decode(bytes);
          if (readOffset !== offset) {
            const firstNewline = text.indexOf("\n");
            if (firstNewline === -1) return [];
            text = text.slice(firstNewline + 1);
          }
          return parseArtifactRows(text, input.session_id);
        } catch {
          return [];
        } finally {
          close();
        }
      },
      close
    };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* no-op */ }
    }
    return null;
  }
}
