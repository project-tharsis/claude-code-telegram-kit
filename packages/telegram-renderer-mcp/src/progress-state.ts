/** Telegram's hard text limit. Normal turns show every step; only the wire limit may fold. */
export const MAX_PROGRESS_CHARACTERS = 4_096;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Fixed headers. The bubble never renders model text, so these are the only variants. */
const HEADERS = {
  open: "Working…",
  Stop: "Done",
  StopFailure: "Failed"
} as const;

export type TurnOutcome = "Stop" | "StopFailure";
export type StepStatus = "running" | "done" | "failed";

export interface TurnKey {
  chatId: string;
  messageId: string;
  sessionId: string;
  promptId: string;
}

interface StepLine {
  display: string;
  toolStatuses: Map<string, StepStatus>;
}

/**
 * Ephemeral per-(chat, prompt) disclosure state. It holds bounded sanitized display strings and
 * lifecycle status only; tool output never enters this state. `generation` advances exactly when
 * an accepted event changes what a reader would see.
 */
export class TurnProgress {
  readonly key: TurnKey;
  #lines: StepLine[] = [];
  #seen = new Set<string>();
  #generation = 0;
  #outcome: TurnOutcome | null = null;

  constructor(key: TurnKey) {
    this.key = key;
  }

  get generation(): number {
    return this.#generation;
  }

  get closed(): boolean {
    return this.#outcome !== null;
  }

  get hasSteps(): boolean {
    return this.#lines.length > 0;
  }

  recordTool(toolUseId: string, display: string): boolean {
    if (this.closed || this.#seen.has(toolUseId)) return false;
    this.#seen.add(toolUseId);
    const last = this.#lines[this.#lines.length - 1];
    if (last !== undefined && last.display === display) {
      last.toolStatuses.set(toolUseId, "running");
    } else {
      this.#lines.push({ display, toolStatuses: new Map([[toolUseId, "running"]]) });
    }
    this.#generation += 1;
    return true;
  }

  #recordStatus(toolUseId: string, status: Exclude<StepStatus, "running">): boolean {
    if (this.closed) return false;
    const line = this.#lines.find(candidate => candidate.toolStatuses.has(toolUseId));
    if (line === undefined || line.toolStatuses.get(toolUseId) !== "running") return false;
    line.toolStatuses.set(toolUseId, status);
    this.#generation += 1;
    return true;
  }

  recordSuccess(toolUseId: string): boolean {
    return this.#recordStatus(toolUseId, "done");
  }

  recordFailure(toolUseId: string): boolean {
    return this.#recordStatus(toolUseId, "failed");
  }

  close(outcome: TurnOutcome): boolean {
    if (this.closed) return false;
    this.#outcome = outcome;
    const terminal: Exclude<StepStatus, "running"> = outcome === "Stop" ? "done" : "failed";
    for (const line of this.#lines) {
      for (const [toolUseId, status] of line.toolStatuses) {
        if (status === "running") line.toolStatuses.set(toolUseId, terminal);
      }
    }
    this.#generation += 1;
    return true;
  }

  render(): string {
    if (!this.hasSteps) return "";
    const header = this.#outcome === null ? HEADERS.open : HEADERS[this.#outcome];
    const renderLine = (line: StepLine): string => {
      const statuses = Array.from(line.toolStatuses.values());
      const icon = statuses.includes("running") ? "…" : statuses.includes("failed") ? "✕" : "✓";
      const count = statuses.length > 1 ? ` ×${statuses.length}` : "";
      return `• ${icon} ${line.display}${count}`;
    };

    const visible: string[] = [];
    let used = codePointLength(header);
    for (let index = 0; index < this.#lines.length; index += 1) {
      const line = renderLine(this.#lines[index]!);
      const remaining = this.#lines.length - index - 1;
      const footer = remaining > 0 ? `… +${remaining} more steps` : "";
      const candidateLength = used
        + 1 + codePointLength(line)
        + (footer ? 1 + codePointLength(footer) : 0);
      if (candidateLength > MAX_PROGRESS_CHARACTERS) break;
      visible.push(line);
      used += 1 + codePointLength(line);
    }

    const overflow = this.#lines.length - visible.length;
    if (overflow > 0) visible.push(`… +${overflow} more steps`);
    return [header, ...visible].join("\n");
  }
}
