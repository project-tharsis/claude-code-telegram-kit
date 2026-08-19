import type { SafeStepLabel } from "./progress-labels.js";

export const MAX_STEP_LINES = 8;

/** Fixed headers. The bubble never renders model text, so these are the only variants. */
const HEADERS = {
  open: "Working…",
  Stop: "Done",
  StopFailure: "Failed"
} as const;

export type TurnOutcome = "Stop" | "StopFailure";

export interface TurnKey {
  chatId: string;
  messageId: string;
  sessionId: string;
  promptId: string;
}

interface StepLine {
  label: SafeStepLabel;
  count: number;
  failed: boolean;
  toolUseIds: Set<string>;
}

/**
 * Ephemeral per-(chat, prompt) disclosure state. It holds labels and counts only: no tool
 * arguments, no outputs, no paths. `generation` advances exactly when an accepted event
 * changes what a reader would see, so a scheduled flush can tell a stale render from a
 * current one.
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

  recordTool(toolUseId: string, label: SafeStepLabel): boolean {
    if (this.closed || this.#seen.has(toolUseId)) return false;
    this.#seen.add(toolUseId);
    const last = this.#lines[this.#lines.length - 1];
    if (last !== undefined && last.label === label) {
      last.count += 1;
      last.toolUseIds.add(toolUseId);
    } else {
      this.#lines.push({ label, count: 1, failed: false, toolUseIds: new Set([toolUseId]) });
    }
    this.#generation += 1;
    return true;
  }

  recordFailure(toolUseId: string): boolean {
    if (this.closed) return false;
    const line = this.#lines.find(candidate => candidate.toolUseIds.has(toolUseId));
    if (line === undefined || line.failed) return false;
    line.failed = true;
    this.#generation += 1;
    return true;
  }

  close(outcome: TurnOutcome): boolean {
    if (this.closed) return false;
    this.#outcome = outcome;
    this.#generation += 1;
    return true;
  }

  render(): string {
    if (!this.hasSteps) return "";
    const header = this.#outcome === null ? HEADERS.open : HEADERS[this.#outcome];
    const visible = this.#lines.slice(0, MAX_STEP_LINES).map(line => {
      const count = line.count > 1 ? ` ×${line.count}` : "";
      const failed = line.failed ? " (failed)" : "";
      return `• ${line.label}${count}${failed}`;
    });
    const overflow = this.#lines.length - MAX_STEP_LINES;
    if (overflow > 0) visible.push(`… +${overflow} more steps`);
    return [header, ...visible].join("\n");
  }
}
