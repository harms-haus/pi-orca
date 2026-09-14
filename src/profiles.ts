import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Lightweight profile-name lookup used to validate orca_subagent's `profile`
 * parameter before a child pi is spawned. A wrong name would otherwise launch
 * a child that warns and silently continues with no profile at all.
 *
 * This is deliberately a guard, not a second parser: real parsing and shadow
 * resolution stay in @harms-haus/pi-agent-profiles. Membership is all we need.
 */

const MAX_SUGGESTIONS = 8;

export interface ProfileScanResult {
  names: string[];
  warnings: string[];
}

/** Scan global and (trusted) project profile dirs for frontmatter names. */
export async function scanProfileNames(
  options: { cwd?: string; projectTrusted?: boolean; agentDir?: string } = {},
): Promise<ProfileScanResult> {
  const directories: string[] = [
    join(options.agentDir ?? join(homedir(), ".pi", "agent"), "profiles"),
  ];
  if (options.projectTrusted) {
    directories.push(join(options.cwd ?? process.cwd(), ".pi", "agent", "profiles"));
  }

  const names = new Set<string>();
  const warnings: string[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".md"))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Absent is normal.
      throw error;
    }
    for (const entry of entries) {
      try {
        const name = parseFrontmatterName(await readFile(join(directory, entry), "utf8"));
        if (name) names.add(name);
      } catch (error) {
        warnings.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { names: [...names].sort((a, b) => a.localeCompare(b)), warnings };
}

/** Extract the frontmatter `name` without a full YAML parser. */
export function parseFrontmatterName(markdown: string): string | undefined {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^name:\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[1]!.replace(/^["']|["']$/g, "").trim();
    return value || undefined;
  }
  return undefined;
}

export interface ProfileValidation {
  ok: boolean;
  error?: string;
}

export async function validateProfileName(
  name: string,
  options: Parameters<typeof scanProfileNames>[0] = {},
): Promise<ProfileValidation> {
  const scan = await scanProfileNames(options);
  if (scan.names.includes(name)) return { ok: true };
  const near = scan.names
    .filter((candidate) => candidate.toLowerCase().includes(name.toLowerCase()))
    .slice(0, MAX_SUGGESTIONS);
  const suggestions =
    near.length > 0
      ? ` Closest known profiles: ${near.join(", ")}.`
      : scan.names.length > 0
        ? ` Known profiles include: ${scan.names.slice(0, MAX_SUGGESTIONS).join(", ")}.`
        : " No profiles were found in ~/.pi/agent/profiles or .pi/agent/profiles.";
  return {
    ok: false,
    error: `Unknown profile '${name}'.${suggestions}`,
  };
}
