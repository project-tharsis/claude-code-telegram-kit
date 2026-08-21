/**
 * User-visible progress labels are a fixed allowlist. Unknown or vendor-controlled tool
 * identifiers never become Telegram text; they degrade to `Working`.
 */

export const DELEGATING_LABEL = "Delegate work";

export const SAFE_STEP_LABELS = [
  "Read file",
  "Read notebook",
  "Find files",
  "Search code",
  "Edit file",
  "Write file",
  "Edit files",
  "Edit notebook",
  "Run command",
  "Read command output",
  "Stop command",
  "Read web page",
  "Search web",
  "Update plan",
  "Finish planning",
  "Run skill",
  DELEGATING_LABEL,
  "Find tool",
  "Use integration",
  "Working"
] as const;

export type SafeStepLabel = (typeof SAFE_STEP_LABELS)[number];

/** Servers this kit owns. Their tools are plumbing, never a user-visible step. */
const SIDECAR_SERVERS = ["telegram-renderer", "session-control"] as const;

const TOOL_LABELS = new Map<string, SafeStepLabel>([
  ["Read", "Read file"],
  ["NotebookRead", "Read notebook"],
  ["Glob", "Find files"],
  ["Grep", "Search code"],
  ["Edit", "Edit file"],
  ["Write", "Write file"],
  ["MultiEdit", "Edit files"],
  ["NotebookEdit", "Edit notebook"],
  ["Bash", "Run command"],
  ["BashOutput", "Read command output"],
  ["KillShell", "Stop command"],
  ["KillBash", "Stop command"],
  ["WebFetch", "Read web page"],
  ["WebSearch", "Search web"],
  ["TodoWrite", "Update plan"],
  ["ExitPlanMode", "Finish planning"],
  ["Skill", "Run skill"],
  ["Task", DELEGATING_LABEL],
  ["Agent", DELEGATING_LABEL],
  ["ToolSearch", "Find tool"]
]);

export function isInternalSidecarTool(toolName: string): boolean {
  return SIDECAR_SERVERS.some(server => toolName.startsWith(`mcp__${server}__`));
}

export function safeStepLabel(toolName: string, _agentId?: string): SafeStepLabel | null {
  if (isInternalSidecarTool(toolName)) return null;
  const known = TOOL_LABELS.get(toolName);
  if (known !== undefined) return known;
  if (toolName.startsWith("mcp__")) return "Use integration";
  return "Working";
}
