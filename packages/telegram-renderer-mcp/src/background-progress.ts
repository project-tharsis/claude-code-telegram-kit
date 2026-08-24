import type { ProgressStep } from "./progress-preview.js";
import { MAX_PROGRESS_CHARACTERS } from "./progress-state.js";

export const MAX_BACKGROUND_AGENTS = 16;
export const MAX_BACKGROUND_TOOL_IDS = 256;
export const MAX_BACKGROUND_TASK_IDS = 16;

export type AgentTerminalStatus = "completed" | "failed" | "killed";
type AgentStatus = "running" | "done" | "failed" | "stopped";
type ToolStatus = "running" | "done" | "failed" | "stopped";

interface AgentState {
  type: string;
  status: AgentStatus;
  lastToolId: string | null;
  lastStep: ProgressStep | null;
  lastToolStatus: ToolStatus | null;
}

function renderStep(step: ProgressStep, status: ToolStatus): string {
  const prefix = status === "failed" ? "❌ " : status === "stopped" ? "⏹ " : "";
  const head = `${prefix}${step.emoji} ${step.label}`;
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

  recordAgentTerminal(agentId: string, terminal: AgentTerminalStatus): boolean {
    const agent = this.#agents.get(agentId);
    if (agent === undefined || agent.status !== "running") return false;
    agent.status = terminal === "completed" ? "done" : terminal === "failed" ? "failed" : "stopped";
    if (agent.lastToolStatus === "running") {
      agent.lastToolStatus = terminal === "completed" ? "done" : terminal === "failed" ? "failed" : "stopped";
    }
    this.#generation += 1;
    return true;
  }

  recordStop(agentId: string): boolean {
    return this.recordAgentTerminal(agentId, "completed");
  }

  render(): string {
    if (!this.hasAgents) return "";
    const agents = Array.from(this.#agents.values());
    const active = agents.filter(agent => agent.status === "running").length;
    const terminalHeader = agents.some(agent => agent.status === "failed")
      ? "Background work · Failed"
      : agents.some(agent => agent.status === "stopped")
        ? "Background work · Stopped"
        : "Background work · Done";
    const header = active > 0
      ? `Background work · ${active} running…`
      : this.#pendingTasks.size > 0
        ? "Background work · Finalizing…"
        : terminalHeader;
    const lines = [header];
    for (const agent of this.#agents.values()) {
      const terminal = agent.status === "done"
        ? { icon: "✅", label: "Done" }
        : agent.status === "failed"
          ? { icon: "❌", label: "Failed" }
          : agent.status === "stopped"
            ? { icon: "⏹", label: "Stopped" }
            : { icon: "👥", label: "Running" };
      const agentLine = `${terminal.icon} ${agent.type} · ${terminal.label}`;
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
