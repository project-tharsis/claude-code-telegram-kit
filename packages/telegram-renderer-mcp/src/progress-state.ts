import type { ProgressStep } from "./progress-preview.js";

/** Telegram's hard text limit. Normal turns show every step; only the wire limit may fold. */
export const MAX_PROGRESS_CHARACTERS = 4_096;

function telegramTextLength(value: string): number {
  return value.length;
}

export interface TurnVerbPair {
  active: string;
  complete: string;
}

/**
 * Selected once per turn. Active forms come from Claude Code's spinner vocabulary;
 * completions must read unambiguously as finished work, never as the assistant's state.
 */
export const TURN_VERB_PAIRS: readonly TurnVerbPair[] = [
  { active: "Baking…", complete: "Baked" },
  { active: "Brewing…", complete: "Brewed" },
  { active: "Churning…", complete: "Churned" },
  { active: "Cogitating…", complete: "Cogitated" },
  { active: "Cooking…", complete: "Cooked" },
  { active: "Crunching…", complete: "Crunched" },
  { active: "Sautéing…", complete: "Sautéed" },
  { active: "Tinkering…", complete: "Tinkered" }
];

export type TurnOutcome = "Stop" | "StopFailure";
export type StepStatus = "running" | "done" | "failed";

export interface TurnKey {
  chatId: string;
  messageId: string;
  sessionId: string;
  promptId: string;
}

export function selectTurnVerbPair(key: Pick<TurnKey, "sessionId" | "promptId">): TurnVerbPair {
  let hash = 2_166_136_261;
  for (const char of `${key.sessionId}/${key.promptId}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return TURN_VERB_PAIRS[(hash >>> 0) % TURN_VERB_PAIRS.length]!;
}

interface StepLine {
  step: ProgressStep;
  toolStatuses: Map<string, StepStatus>;
}

function sameStep(left: ProgressStep, right: ProgressStep): boolean {
  return left.emoji === right.emoji
    && left.label === right.label
    && left.kind === right.kind
    && left.connector === right.connector
    && left.preview === right.preview;
}

function renderStep(line: StepLine): string {
  const statuses = Array.from(line.toolStatuses.values());
  const failed = statuses.includes("failed");
  const prefix = failed ? "❌ " : "";
  const count = statuses.length > 1 ? ` ×${statuses.length}` : "";
  const head = `${prefix}${line.step.emoji} ${line.step.label}${count}`;
  if (!line.step.preview) return head;
  if (line.step.kind === "command") {
    return `${head}\n\`\`\`shell\n${line.step.preview}\n\`\`\``;
  }
  return `${prefix}${line.step.emoji} ${line.step.label}${line.step.connector}${line.step.preview}${count}`;
}

/**
 * Ephemeral per-(chat, prompt) disclosure state. It holds bounded sanitized presentation data and
 * lifecycle status only; tool output never enters this state. `generation` advances exactly when
 * an accepted event changes what a reader would see.
 */
export class TurnProgress {
  readonly key: TurnKey;
  readonly #verbs: TurnVerbPair;
  #lines: StepLine[] = [];
  #seen = new Set<string>();
  #generation = 0;
  #outcome: TurnOutcome | null = null;

  constructor(key: TurnKey, verbs: TurnVerbPair = selectTurnVerbPair(key)) {
    this.key = key;
    this.#verbs = verbs;
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

  recordTool(toolUseId: string, step: ProgressStep): boolean {
    if (this.closed || this.#seen.has(toolUseId)) return false;
    this.#seen.add(toolUseId);
    const last = this.#lines[this.#lines.length - 1];
    if (last !== undefined && sameStep(last.step, step)) {
      last.toolStatuses.set(toolUseId, "running");
    } else {
      this.#lines.push({ step, toolStatuses: new Map([[toolUseId, "running"]]) });
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
    const header = this.#outcome === null
      ? this.#verbs.active
      : this.#outcome === "Stop" ? this.#verbs.complete : "Failed";
    const visible: string[] = [];
    let used = telegramTextLength(header);
    for (let index = 0; index < this.#lines.length; index += 1) {
      const line = renderStep(this.#lines[index]!);
      const remaining = this.#lines.length - index - 1;
      const footer = remaining > 0 ? `… +${remaining} more steps` : "";
      const candidateLength = used
        + 1 + telegramTextLength(line)
        + (footer ? 1 + telegramTextLength(footer) : 0);
      if (candidateLength > MAX_PROGRESS_CHARACTERS) break;
      visible.push(line);
      used += 1 + telegramTextLength(line);
    }

    const overflow = this.#lines.length - visible.length;
    if (overflow > 0) visible.push(`… +${overflow} more steps`);
    return [header, ...visible].join("\n");
  }
}
