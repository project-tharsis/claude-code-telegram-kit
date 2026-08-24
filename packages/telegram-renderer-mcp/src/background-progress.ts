import type { ProgressStep } from "./progress-preview.js";
import { MAX_PROGRESS_CHARACTERS } from "./progress-state.js";

export const MAX_BACKGROUND_AGENTS = 16;
export const MAX_BACKGROUND_TOOL_IDS = 256;
export const MAX_BACKGROUND_TASK_IDS = 16;

type AgentStatus = "running" | "done";
type ToolStatus = "running" | "done" | "failed";

interface AgentState {
  type: string;
  status: AgentStatus;
  lastToolId: string | null;
  lastStep: ProgressStep | null;
  lastToolStatus: ToolStatus | null;
}

function renderStep(step: ProgressStep, status: ToolStatus): string {
  const failed = status === "failed" ? "❌ " : "";
  const head = `${failed}${step.emoji} ${step.label}`;
  if (!step.preview || step.kind === "command") return head;
  return `${head}${step.connector}${step.preview}`;
}

/**
 * Bounded, event-driven status for subagents spawned by one bound Telegram turn.
 * It accepts lifecycle metadata and sanitized tool presentations only. No timer,
 * transcript polling, model prose, raw tool input, or tool output enters this state.
 */
export class BackgroundProgress {
  #agents = new Map<string, AgentState>();
  #toolAgents = new Map<string, string>();
  #pendingTasks = new Set<string>();
  #generation = 0;

  get generation(): number {
    return this.#generation;
  }

  get hasAgents(): boolean {
    return this.#agents.size > 0;
  }

  get hasActive(): boolean {
    return Array.from(this.#agents.values()).some(agent => agent.status === "running");
  }

  get hasPendingTasks(): boolean {
    return this.#pendingTasks.size > 0;
  }

  recordTaskStart(toolUseId: string): boolean {
    if (this.#pendingTasks.has(toolUseId) || this.#pendingTasks.size >= MAX_BACKGROUND_TASK_IDS) return false;
    this.#pendingTasks.add(toolUseId);
    this.#generation += 1;
    return true;
  }

  recordTaskTerminal(toolUseId: string): boolean {
    if (!this.#pendingTasks.delete(toolUseId)) return false;
    this.#generation += 1;
    return true;
  }

  recordStart(agentId: string, agentType: string): boolean {
    const existing = this.#agents.get(agentId);
    if (existing !== undefined) return false;
    if (this.#agents.size >= MAX_BACKGROUND_AGENTS) return false;
    this.#agents.set(agentId, {
      type: agentType,
      status: "running",
      lastToolId: null,
      lastStep: null,
      lastToolStatus: null
    });
    this.#generation += 1;
    return true;
  }

  recordTool(agentId: string, toolUseId: string, step: ProgressStep): boolean {
    const agent = this.#agents.get(agentId);
    if (agent === undefined || agent.status !== "running" || this.#toolAgents.has(toolUseId)) {
      return false;
    }
    while (this.#toolAgents.size >= MAX_BACKGROUND_TOOL_IDS) {
      const oldest = this.#toolAgents.keys().next();
      if (oldest.done === true) break;
      this.#toolAgents.delete(oldest.value);
    }
    this.#toolAgents.set(toolUseId, agentId);
    agent.lastToolId = toolUseId;
    agent.lastStep = step;
    agent.lastToolStatus = "running";
    this.#generation += 1;
    return true;
  }

  #recordToolStatus(toolUseId: string, status: Exclude<ToolStatus, "running">): boolean {
    const agentId = this.#toolAgents.get(toolUseId);
    if (agentId === undefined) return false;
    const agent = this.#agents.get(agentId);
    if (agent === undefined || agent.lastToolId !== toolUseId || agent.lastToolStatus !== "running") {
      return false;
    }
    agent.lastToolStatus = status;
    this.#generation += 1;
    return true;
  }

  recordSuccess(toolUseId: string): boolean {
    return this.#recordToolStatus(toolUseId, "done");
  }

  recordFailure(toolUseId: string): boolean {
    return this.#recordToolStatus(toolUseId, "failed");
  }

  recordStop(agentId: string): boolean {
    const agent = this.#agents.get(agentId);
    if (agent === undefined || agent.status === "done") return false;
    agent.status = "done";
    if (agent.lastToolStatus === "running") agent.lastToolStatus = "done";
    this.#generation += 1;
    return true;
  }

  render(): string {
    if (!this.hasAgents) return "";
    const active = Array.from(this.#agents.values())
      .filter(agent => agent.status === "running").length;
    const header = active > 0
      ? `Background work · ${active} running…`
      : this.#pendingTasks.size > 0
        ? "Background work · Finalizing…"
        : "Background work · Done";
    const lines = [header];
    for (const agent of this.#agents.values()) {
      const status = agent.status === "running" ? "Running" : "Done";
      const icon = agent.status === "running" ? "👥" : "✅";
      const agentLine = `${icon} ${agent.type} · ${status}`;
      const stepLine = agent.lastStep === null || agent.lastToolStatus === null
        ? null
        : `└ ${renderStep(agent.lastStep, agent.lastToolStatus)}`;
      const additions = stepLine === null ? [agentLine] : [agentLine, stepLine];
      if ([...lines, ...additions].join("\n").length > MAX_PROGRESS_CHARACTERS) {
        lines.push("… more agents");
        break;
      }
      lines.push(...additions);
    }
    return lines.join("\n");
  }
}
