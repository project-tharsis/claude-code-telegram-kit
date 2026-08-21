import {
  safeStepPresentation,
  type SafeStepLabel,
  type StepPresentationKind
} from "./progress-labels.js";
import { sanitizeProgressPreview } from "./progress-preview-sanitizer.js";

export type ToolDisclosureMode = "safe" | "all" | "verbose";

export interface ToolPreviewFields {
  command?: string | undefined;
  file_path?: string | undefined;
  path?: string | undefined;
  pattern?: string | undefined;
  query?: string | undefined;
  url?: string | undefined;
  skill?: string | undefined;
  description?: string | undefined;
  offset?: string | undefined;
  limit?: string | undefined;
}

export interface ProgressStep {
  emoji: string;
  label: SafeStepLabel;
  kind: StepPresentationKind;
  connector: " " | " for ";
  preview?: string | undefined;
}


function positiveInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/")
    .filter(part => part !== "" && part !== "." && part !== "..");
  const name = parts.at(-1) ?? "";
  return /^[A-Za-z]:$/.test(name) ? "" : name;
}

function readPreview(fields: ToolPreviewFields): string {
  const path = fields.file_path ?? fields.path ?? "";
  if (!path) return "";
  const name = basename(path);
  const offset = positiveInteger(fields.offset);
  if (offset === null) return name;
  const limit = positiveInteger(fields.limit);
  const canAddLimit = limit !== null && limit - 1 <= Number.MAX_SAFE_INTEGER - offset;
  const range = canAddLimit ? `L${offset}-${offset + limit - 1}` : `L${offset}`;
  return `${name} ${range}`;
}

function previewSource(toolName: string, fields: ToolPreviewFields): string {
  switch (toolName) {
    case "Bash": return fields.command ?? "";
    case "Read":
    case "NotebookRead": return readPreview(fields);
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": return basename(fields.file_path ?? fields.path ?? "");
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
    case "Agent": return fields.description ?? "";
    case "Skill": return fields.skill ?? fields.description ?? "";
    case "Artifact": return fields.description ?? "";
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
): ProgressStep | null {
  const presentation = safeStepPresentation(toolName, agentId);
  if (presentation === null) return null;
  if (mode === "safe") return { ...presentation };
  const preview = sanitizeProgressPreview(previewSource(toolName, fields), {
    maxLength: toolName === "Skill" ? 128 : mode === "verbose" ? 40 : 28,
    truncation: toolName === "Bash" ? "middle" : "end",
    stripLeadingCdWrapper: toolName === "Bash"
  });
  return preview ? { ...presentation, preview } : { ...presentation };
}
