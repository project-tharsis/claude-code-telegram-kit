/**
 * User-visible progress presentation is a fixed allowlist. Unknown or vendor-controlled tool
 * identifiers never become Telegram text; they degrade to one generic presentation.
 */

export const DELEGATING_LABEL = "Delegating";

export const SAFE_STEP_LABELS = [
  "Reading",
  "Reading notebook",
  "Finding files",
  "Searching code",
  "Editing",
  "Writing",
  "Editing files",
  "Editing notebook",
  "terminal",
  "Reading command output",
  "Stopping command",
  "Reading web page",
  "Searching web",
  "Updating plan",
  "Finishing planning",
  "Reading skill",
  DELEGATING_LABEL,
  "Finding tool",
  "Creating artifact",
  "Using integration",
  "Working"
] as const;

export type SafeStepLabel = (typeof SAFE_STEP_LABELS)[number];
export type StepPresentationKind = "inline" | "command";

export interface SafeStepPresentation {
  emoji: string;
  label: SafeStepLabel;
  kind: StepPresentationKind;
  connector: " " | " for ";
}

/** Servers this kit owns. Their tools are plumbing, never a user-visible step. */
const SIDECAR_SERVERS = ["telegram-renderer", "session-control"] as const;

const inline = (
  emoji: string,
  label: SafeStepLabel,
  connector: SafeStepPresentation["connector"] = " "
): SafeStepPresentation => ({ emoji, label, kind: "inline", connector });

const TOOL_PRESENTATIONS = new Map<string, SafeStepPresentation>([
  ["Read", inline("📖", "Reading")],
  ["NotebookRead", inline("📓", "Reading notebook")],
  ["Glob", inline("🗂️", "Finding files")],
  ["Grep", inline("🔎", "Searching code", " for ")],
  ["Edit", inline("🔧", "Editing")],
  ["Write", inline("✍️", "Writing")],
  ["MultiEdit", inline("🔧", "Editing files")],
  ["NotebookEdit", inline("🔧", "Editing notebook")],
  ["Bash", { emoji: "💻", label: "terminal", kind: "command", connector: " " }],
  ["BashOutput", inline("🖥️", "Reading command output")],
  ["KillShell", inline("🛑", "Stopping command")],
  ["KillBash", inline("🛑", "Stopping command")],
  ["WebFetch", inline("🌐", "Reading web page")],
  ["WebSearch", inline("🔍", "Searching web", " for ")],
  ["TodoWrite", inline("📋", "Updating plan")],
  ["ExitPlanMode", inline("✅", "Finishing planning")],
  ["Skill", inline("📚", "Reading skill")],
  ["Task", inline("👥", DELEGATING_LABEL)],
  ["Agent", inline("👥", DELEGATING_LABEL)],
  ["ToolSearch", inline("🧰", "Finding tool")],
  ["Artifact", inline("📦", "Creating artifact")]
]);

const INTEGRATION_PRESENTATION = inline("🔌", "Using integration");
const UNKNOWN_PRESENTATION = inline("⚙️", "Working");

export function isInternalSidecarTool(toolName: string): boolean {
  return SIDECAR_SERVERS.some(server => toolName.startsWith(`mcp__${server}__`));
}

export function safeStepPresentation(
  toolName: string,
  _agentId?: string
): SafeStepPresentation | null {
  if (isInternalSidecarTool(toolName)) return null;
  const known = TOOL_PRESENTATIONS.get(toolName);
  if (known !== undefined) return known;
  if (toolName.startsWith("mcp__")) return INTEGRATION_PRESENTATION;
  return UNKNOWN_PRESENTATION;
}

export function safeStepLabel(toolName: string, agentId?: string): SafeStepLabel | null {
  return safeStepPresentation(toolName, agentId)?.label ?? null;
}
