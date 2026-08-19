import { isInternalSidecarTool } from "./progress-labels.js";
import { sanitizeProgressPreview } from "./progress-preview-sanitizer.js";

export type ToolDisclosureMode = "safe" | "all" | "verbose";

export interface ToolPreviewFields {
  command?: string | undefined;
  file_path?: string | undefined;
  path?: string | undefined;
  pattern?: string | undefined;
  query?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
}

const LABELS = new Map<string, string>([
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
  ["Task", "Delegate work"],
  ["Agent", "Delegate work"]
]);

function integrationLabel(toolName: string): string {
  const match = /^mcp__([A-Za-z0-9_.:-]{1,64})__([A-Za-z0-9_.:-]{1,64})$/.exec(toolName);
  return match === null ? "Use integration" : `Use ${match[1]}.${match[2]}`;
}

function previewSource(toolName: string, fields: ToolPreviewFields): string {
  switch (toolName) {
    case "Bash": return fields.command ?? "";
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookRead":
    case "NotebookEdit": return fields.file_path ?? fields.path ?? "";
    case "Grep":
    case "Glob": {
      const pattern = fields.pattern ?? "";
      const path = fields.path ?? "";
      return pattern && path ? `${pattern} in ${path}` : pattern || path;
    }
    case "WebSearch": return fields.query ?? "";
    case "WebFetch": return fields.url ?? "";
    case "Task":
    case "Agent":
    case "Skill": return fields.description ?? "";
    default:
      return fields.command ?? fields.file_path ?? fields.path ?? fields.query ?? fields.url ?? fields.description ?? "";
  }
}

export function parseToolDisclosureMode(value: unknown): ToolDisclosureMode {
  return value === "safe" || value === "all" || value === "verbose" ? value : "safe";
}

export function buildProgressStep(
  toolName: string,
  fields: ToolPreviewFields,
  mode: ToolDisclosureMode,
  agentId?: string
): string | null {
  if (isInternalSidecarTool(toolName)) return null;
  const label = agentId
    ? "Delegate work"
    : LABELS.get(toolName) ?? (toolName.startsWith("mcp__") ? integrationLabel(toolName) : toolName || "Work");
  if (mode === "safe") return label;
  const preview = sanitizeProgressPreview(previewSource(toolName, fields), {
    maxLength: mode === "verbose" ? 320 : 96
  });
  return preview ? `${label} — ${preview}` : label;
}
