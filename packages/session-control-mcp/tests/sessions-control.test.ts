import { describe, expect, test } from "bun:test";
import { createSessionsController } from "../src/sessions-control.js";
import type { CommandCapability } from "../src/command-capability.js";
import type { SessionCatalogEntry } from "../src/session-catalog.js";
import type { SelectionSnapshot } from "../src/session-selection.js";
import type { RuntimeConfig } from "@project-tharsis/claude-code-telegram-shared";

const CURRENT = "3fcbaf06-4378-4339-b026-8c2e026a65e7";
const config: RuntimeConfig = { token: "1:tok", allowedChatIds: new Set(["123"]) };

function uuid(n: number): string {
  const hex = n.toString(16).padStart(2, "0");
  return `${hex.repeat(4)}-${hex.repeat(2)}-4${hex.repeat(2).slice(1)}-8${hex.repeat(2).slice(1)}-${hex.repeat(6)}`;
}

function capability(command: "sessions" | "resume", index?: number): CommandCapability {
  return {
    chatId: "123",
    messageId: "51",
    sessionId: CURRENT,
    promptId: "p1",
    command,
    ...(index === undefined ? {} : { index }),
    expiresAt: 10_000
  };
}

interface HarnessOptions {
  capability?: CommandCapability | null;
  entries?: SessionCatalogEntry[];
  snapshot?: SelectionSnapshot | null;
  helperReady?: boolean;
  verify?: (sessionId: string) => void;
  send?: () => Promise<number>;
  schedule?: () => Promise<string>;
  writeSnapshot?: () => void;
  react?: () => Promise<boolean>;
}

function harness(options: HarnessOptions = {}) {
  const takes: Array<[string, string, number | undefined]> = [];
  const sent: Array<{ text: string; replyTo?: string }> = [];
  const scheduled: Array<[string, string, string]> = [];
  const written: unknown[] = [];
  const verified: string[] = [];
  const reactions: Array<[string, string, string]> = [];

  const controller = createSessionsController({
    loadConfig: () => config,
    capabilities: {
      take: (chatId, command, index) => {
        takes.push([chatId, command, index]);
        if (options.capability !== undefined) return options.capability;
        return { ...capability(command, index), chatId };
      }
    },
    scanSessions: () => options.entries ?? [],
    readSnapshot: () => options.snapshot ?? null,
    writeSnapshot: snapshot => {
      if (options.writeSnapshot) options.writeSnapshot();
      written.push(snapshot);
    },
    verifySelectedSession: sessionId => {
      verified.push(sessionId);
      options.verify?.(sessionId);
    },
    sendMessage: async (_config, _chatId, text, replyTo) => {
      sent.push(replyTo === undefined ? { text } : { text, replyTo });
      return options.send ? options.send() : 900;
    },
    react: async (_config, chatId, messageId, state) => {
      reactions.push([chatId, messageId, state]);
      return options.react ? options.react() : true;
    },
    scheduleResume: async (chatId, messageId, sessionId) => {
      scheduled.push([chatId, messageId, sessionId]);
      return options.schedule ? options.schedule() : "claude-session-reset-resume-abc";
    },
    helperReady: () => options.helperReady ?? true,
    now: () => 5_000
  });

  return { controller, takes, sent, scheduled, written, verified, reactions };
}

const ENTRIES: SessionCatalogEntry[] = [
  { sessionId: uuid(1), title: "Refactor the parser", lastActivityMs: 5_000 - 12 * 60_000 },
  { sessionId: uuid(2), title: "Draft the release notes", lastActivityMs: 5_000 - 3 * 3_600_000 }
];

describe("/sessions listing", () => {
  test("sends a numbered list quoting the command and snapshots the mapping", async () => {
    const h = harness({ entries: ENTRIES });

    const receipt = await h.controller.listSessions({ chat_id: "123" });

    expect(h.takes).toEqual([["123", "sessions", undefined]]);
    expect(h.sent).toEqual([{
      text: "Recent sessions (2). Reply /resume N to continue one.\n\n"
        + "1. Refactor the parser — 12m ago\n"
        + "2. Draft the release notes — 3h ago",
      replyTo: "51"
    }]);
    expect(h.written).toEqual([{
      chatId: "123",
      sessionId: CURRENT,
      entries: [
        { index: 1, sessionId: uuid(1) },
        { index: 2, sessionId: uuid(2) }
      ]
    }]);
    expect(h.reactions).toEqual([["123", "51", "success"]]);
    expect(receipt).toEqual({ status: "listed", count: 2, ackMessageId: 900 });
  });

  test("keeps a confirmed list successful when reaction finalization fails", async () => {
    const h = harness({
      entries: ENTRIES,
      react: async () => {
        throw new Error("reaction timeout");
      }
    });

    await expect(h.controller.listSessions({ chat_id: "123" })).resolves.toMatchObject({
      status: "listed",
      count: 2
    });
  });

  test("never leaks a session UUID or a transcript path into the message", async () => {
    const h = harness({ entries: ENTRIES });
    await h.controller.listSessions({ chat_id: "123" });
    for (const entry of ENTRIES) expect(h.sent[0]!.text).not.toContain(entry.sessionId);
    expect(h.sent[0]!.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(h.sent[0]!.text).not.toMatch(/\/[A-Za-z0-9_.-]+\//);
    expect(h.sent[0]!.text).not.toContain(".jsonl");
  });

  test("activates the snapshot only after the list is delivered", async () => {
    const order: string[] = [];
    const h = harness({
      entries: ENTRIES,
      writeSnapshot: () => order.push("snapshot"),
      send: async () => {
        order.push("send");
        return 900;
      }
    });
    await h.controller.listSessions({ chat_id: "123" });
    expect(order).toEqual(["send", "snapshot"]);
  });

  test("reports an empty catalog without writing a snapshot", async () => {
    const h = harness({ entries: [] });

    const receipt = await h.controller.listSessions({ chat_id: "123" });

    expect(h.written).toEqual([]);
    expect(h.sent[0]!.text).toBe("No other resumable sessions were found.");
    expect(receipt).toEqual({ status: "listed", count: 0, ackMessageId: 900 });
  });

  test("fails closed without a current /sessions capability", async () => {
    const h = harness({ capability: null, entries: ENTRIES });
    await expect(h.controller.listSessions({ chat_id: "123" })).rejects.toThrow("no current /sessions command");
    expect(h.sent).toEqual([]);
    expect(h.written).toEqual([]);
  });

  test("refuses an unauthorized chat", async () => {
    const h = harness({ entries: ENTRIES });
    await expect(h.controller.listSessions({ chat_id: "777" })).rejects.toThrow();
    expect(h.sent).toEqual([]);
  });

  test("does not claim success when the list cannot be delivered", async () => {
    const h = harness({
      entries: ENTRIES,
      send: async () => {
        throw new Error("Telegram control notification failed");
      }
    });
    await expect(h.controller.listSessions({ chat_id: "123" })).rejects.toThrow("session list delivery failed");
    expect(h.written).toEqual([]);
  });
});

describe("/resume N", () => {
  const snapshot: SelectionSnapshot = {
    chatId: "123",
    sessionId: CURRENT,
    createdAt: 0,
    entries: [
      { index: 1, sessionId: uuid(1) },
      { index: 2, sessionId: uuid(2) }
    ]
  };

  test("resolves the index through the snapshot and schedules the exact UUID", async () => {
    const h = harness({ capability: capability("resume", 2), snapshot });

    const receipt = await h.controller.resumeSession({ chat_id: "123", index: 2 });

    expect(h.takes).toEqual([["123", "resume", 2]]);
    expect(h.verified).toEqual([uuid(2)]);
    expect(h.sent).toEqual([{ text: "Resuming session 2. Switching now…", replyTo: "51" }]);
    expect(h.scheduled).toEqual([["123", "51", uuid(2)]]);
    expect(h.reactions).toEqual([["123", "51", "success"]]);
    expect(receipt).toEqual({
      status: "scheduled",
      ackMessageId: 900,
      unit: "claude-session-reset-resume-abc"
    });
  });

  test("fails closed without a matching capability index", async () => {
    const h = harness({ capability: null, snapshot });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 2 })).rejects.toThrow("no current /resume");
    expect(h.scheduled).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("rejects an index outside the listed range before any side effect", async () => {
    for (const index of [0, 3, 11, 1.5]) {
      const h = harness({ capability: capability("resume", index), snapshot });
      await expect(h.controller.resumeSession({ chat_id: "123", index })).rejects.toThrow();
      expect(h.scheduled).toEqual([]);
      expect(h.sent).toEqual([]);
    }
  });

  test("rejects a missing or expired snapshot", async () => {
    const h = harness({ capability: capability("resume", 1), snapshot: null });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow("session selection expired");
    expect(h.scheduled).toEqual([]);
  });

  test("rejects a snapshot belonging to a different chat", async () => {
    const h = harness({
      capability: capability("resume", 1),
      snapshot: { ...snapshot, chatId: "999" }
    });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow();
    expect(h.scheduled).toEqual([]);
  });

  test("refuses to resume the session that is currently running", async () => {
    const h = harness({
      capability: capability("resume", 1),
      snapshot: { ...snapshot, entries: [{ index: 1, sessionId: CURRENT }] }
    });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow("current session");
    expect(h.scheduled).toEqual([]);
  });

  test("refuses when the selected transcript no longer revalidates", async () => {
    const h = harness({
      capability: capability("resume", 1),
      snapshot,
      verify: () => {
        throw new Error("selected session transcript is not usable");
      }
    });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });

  test("refuses when the root helper preflight did not pass", async () => {
    const h = harness({ capability: capability("resume", 1), snapshot, helperReady: false });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow("unavailable");
    expect(h.sent).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });

  test("does not schedule when the acknowledgement cannot be delivered", async () => {
    const h = harness({
      capability: capability("resume", 1),
      snapshot,
      send: async () => {
        throw new Error("Telegram control notification failed");
      }
    });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow("was not scheduled");
    expect(h.scheduled).toEqual([]);
  });

  test("reports a scheduler failure and tells the chat nothing happened", async () => {
    let calls = 0;
    const h = harness({
      capability: capability("resume", 1),
      snapshot,
      schedule: async () => {
        throw new Error("systemd rejected the resume job");
      },
      send: async () => {
        calls += 1;
        return 900 + calls;
      }
    });
    await expect(h.controller.resumeSession({ chat_id: "123", index: 1 })).rejects.toThrow("resume scheduler failed");
    expect(h.sent.map(message => message.text)).toEqual([
      "Resuming session 1. Switching now…",
      "Session resume scheduling failed. No resume was started."
    ]);
    expect(h.reactions).toEqual([
      ["123", "51", "success"],
      ["123", "51", "failure"]
    ]);
  });
});
