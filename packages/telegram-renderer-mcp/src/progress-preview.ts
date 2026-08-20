import { safeStepLabel } from "./progress-labels.js";
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
    case "ToolSearch": return fields.query ?? "";
    case "Task":
    case "Agent":
    case "Skill": return fields.description ?? "";
    default: return toolName.startsWith("mcp__")
      ? fields.query ?? fields.description ?? ""
      : "";
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
  const label = safeStepLabel(toolName, agentId);
  if (label === null) return null;
  if (mode === "safe") return label;
  const preview = sanitizeProgressPreview(previewSource(toolName, fields), {
    maxLength: mode === "verbose" ? 40 : 28
  });
  return preview ? `${label} — ${preview}` : label;
}
