/**
 * The progress bubble may only ever show labels from this fixed set. Tool names, arguments,
 * paths, commands, URLs, and outputs never reach Telegram, so an unknown or attacker-chosen
 * tool name degrades to a generic label instead of becoming a disclosure channel.
 */

export const DELEGATING_LABEL = "Delegating work";

export const SAFE_STEP_LABELS = [
  "Reading files",
  "Editing files",
  "Running commands",
  "Searching the web",
  "Planning",
  "Running a skill",
  DELEGATING_LABEL,
  "Using an integration",
  "Working"
] as const;

export type SafeStepLabel = (typeof SAFE_STEP_LABELS)[number];

/** Servers this kit owns. Their tools are plumbing, never a user-visible step. */
const SIDECAR_SERVERS = ["telegram-renderer", "session-control"] as const;

const TOOL_LABELS = new Map<string, SafeStepLabel>([
  ["Read", "Reading files"],
  ["Glob", "Reading files"],
  ["Grep", "Reading files"],
  ["NotebookRead", "Reading files"],
  ["Edit", "Editing files"],
  ["Write", "Editing files"],
  ["MultiEdit", "Editing files"],
  ["NotebookEdit", "Editing files"],
  ["Bash", "Running commands"],
  ["BashOutput", "Running commands"],
  ["KillShell", "Running commands"],
  ["KillBash", "Running commands"],
  ["WebFetch", "Searching the web"],
  ["WebSearch", "Searching the web"],
  ["TodoWrite", "Planning"],
  ["ExitPlanMode", "Planning"],
  ["Skill", "Running a skill"],
  ["Task", DELEGATING_LABEL],
  ["Agent", DELEGATING_LABEL]
]);

export function isInternalSidecarTool(toolName: string): boolean {
  return SIDECAR_SERVERS.some(server => toolName.startsWith(`mcp__${server}__`));
}

/**
 * Returns the fixed label for a tool, or `null` when the step must not be shown at all.
 * Any tool invoked inside a subagent collapses to one delegating label so subagent
 * internals never fan out into the bubble.
 */
export function safeStepLabel(toolName: string, agentId?: string): SafeStepLabel | null {
  if (isInternalSidecarTool(toolName)) return null;
  if (agentId !== undefined && agentId !== "") return DELEGATING_LABEL;
  const known = TOOL_LABELS.get(toolName);
  if (known !== undefined) return known;
  if (toolName.startsWith("mcp__")) return "Using an integration";
  return "Working";
}
