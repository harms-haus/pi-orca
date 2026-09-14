import { OrcaCliError } from "./orca-cli.js";

/** Build a text-only tool result. `details` is required by AgentToolResult. */
export function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

/** Render unknown JSON results for the LLM. */
export function renderResult(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export const OUTPUT_LIMIT = 16_000;

/** Keep the tail of long output: for terminals, the newest lines matter most. */
export function clipTail(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `[truncated ${text.length - limit} leading characters; showing the last ${limit}]\n${text.slice(-limit)}`;
}

/** Keep the head of long output: for snapshots, structure comes first. */
export function clipHead(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} trailing characters]`;
}

/** Convert an OrcaCliError into an actionable tool-facing message. */
export function orcaErrorMessage(error: unknown): string {
  if (error instanceof OrcaCliError) {
    if (error.kind === "unavailable") {
      return `${error.message} (check that the Orca app is running)`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Untitled-tasks get a compact slug so Orca tab titles stay scannable. */
export function slugify(text: string, maxLength = 24): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  return slug || "task";
}
