const TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COMPLETE_ENVELOPE = /^\s*<task-notification>\s*([\s\S]*?)\s*<\/task-notification>\s*$/;

export interface TerminalTaskNotification {
  toolUseId?: string;
  taskId?: string;
  status: "completed" | "failed" | "killed";
}

export interface CompletedTaskNotification {
  toolUseId: string;
  taskId?: string;
}

function exactTag(body: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>\\s*([^<>]*?)\\s*</${tag}>`, "g");
  const matches = Array.from(body.matchAll(pattern));
  if (matches.length !== 1) return null;
  const value = matches[0]?.[1]?.trim();
  return value ? value : null;
}

/** Parse only Claude's complete internal terminal task-notification prompt. */
export function parseTerminalTaskNotification(prompt: string): TerminalTaskNotification | null {
  if (typeof prompt !== "string" || prompt.length > 1_000_000) return null;
  const body = COMPLETE_ENVELOPE.exec(prompt)?.[1];
  if (body === undefined) return null;
  const header = body.split(/<(?:summary|result)\b/i, 1)[0]!;
  const status = exactTag(header, "status");
  if (status !== "completed" && status !== "failed" && status !== "killed") return null;
  const toolUseId = exactTag(header, "tool-use-id");
  if (toolUseId !== null && !TOOL_USE_ID.test(toolUseId)) return null;
  const taskId = exactTag(header, "task-id");
  if (taskId !== null && !TASK_ID.test(taskId)) return null;
  if (toolUseId === null && taskId === null) return null;
  return {
    status,
    ...(toolUseId === null ? {} : { toolUseId }),
    ...(taskId === null ? {} : { taskId })
  };
}

export function parseCompletedTaskNotification(prompt: string): CompletedTaskNotification | null {
  const notification = parseTerminalTaskNotification(prompt);
  if (notification === null || notification.status !== "completed" || notification.toolUseId === undefined) return null;
  const { toolUseId, taskId } = notification;
  return { toolUseId, ...(taskId === undefined ? {} : { taskId }) };
}
