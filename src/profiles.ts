import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Lightweight profile lookup used to resolve orca_subagent's `profile`
 * parameter before a child CLI is spawned. A wrong name would otherwise launch
 * a child that warns and silently continues with no profile at all.
 *
 * This is deliberately a guard, not a second parser: real parsing and shadow
 * resolution stay in @harms-haus/pi-agent-profiles. Name, agent, model, and
 * body are all we need to build the launch command.
 */

const MAX_SUGGESTIONS = 8;

/** Thinking levels shared with @harms-haus/pi-agent-profiles; forwarded to
 * child CLIs as their effort settings. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** CLI clients that can run a profile; `pi` is the default when `agent` is absent. */
export type ProfileAgent = "pi" | "codex" | "claude";
export const PROFILE_AGENTS: readonly ProfileAgent[] = ["pi", "codex", "claude"];

/** A profile as found on disk; `agent` is the raw frontmatter value, if any. */
export interface ScannedProfile {
  name: string;
  agent?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  body: string;
}

/** A profile validated for launching, with `agent` resolved to a known client. */
export interface ResolvedProfile {
  name: string;
  agent: ProfileAgent;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  body: string;
}

export interface ProfileScanResult {
  profiles: ScannedProfile[];
  warnings: string[];
}

/** Scan global and (trusted) project profile dirs; project files shadow global ones by name. */
export async function scanProfiles(
  options: { cwd?: string; projectTrusted?: boolean; agentDir?: string } = {},
): Promise<ProfileScanResult> {
  const directories: string[] = [
    join(options.agentDir ?? join(homedir(), ".pi", "agent"), "profiles"),
  ];
  if (options.projectTrusted) {
    directories.push(join(options.cwd ?? process.cwd(), ".pi", "agent", "profiles"));
  }

  const byName = new Map<string, ScannedProfile>();
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
        const parsed = parseProfileFrontmatter(await readFile(join(directory, entry), "utf8"));
        if (parsed.name) byName.set(parsed.name, { ...parsed, name: parsed.name });
      } catch (error) {
        warnings.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const profiles = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { profiles, warnings };
}

/** Fields extracted from a profile's frontmatter; `body` is the markdown after `---`. */
export interface ProfileFrontmatter {
  name?: string;
  agent?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Extract `name`, `agent`, `model`, and `thinkingLevel` plus the body without
 * a full YAML parser. Invalid thinking levels are ignored, matching
 * @harms-haus/pi-agent-profiles. */
export function parseProfileFrontmatter(markdown: string): ProfileFrontmatter {
  const match = markdown.match(FRONTMATTER_RE);
  if (match === null) return { body: markdown.trim() };
  const parsed: ProfileFrontmatter = { body: markdown.slice(match[0].length).trim() };
  for (const line of match[1]!.split(/\r?\n/)) {
    for (const key of ["name", "agent", "model"] as const) {
      if (parsed[key] !== undefined) continue;
      const value = line.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`))?.[1];
      if (value === undefined) continue;
      const unquoted = value.replace(/^["']|["']$/g, "").trim();
      if (unquoted) parsed[key] = unquoted;
    }
    if (parsed.thinkingLevel === undefined) {
      const value = line.match(/^thinkingLevel:\s*(.*?)\s*$/)?.[1];
      if (value !== undefined) {
        const unquoted = value.replace(/^["']|["']$/g, "").trim();
        if ((THINKING_LEVELS as readonly string[]).includes(unquoted))
          parsed.thinkingLevel = unquoted as ThinkingLevel;
      }
    }
  }
  return parsed;
}

export interface ProfileValidation {
  ok: boolean;
  error?: string;
}

export interface ProfileLookup extends ProfileValidation {
  profile?: ResolvedProfile;
}

/** Resolve a profile name to a launchable record, validating its `agent` value. */
export async function lookupProfile(
  name: string,
  options: Parameters<typeof scanProfiles>[0] = {},
): Promise<ProfileLookup> {
  const scan = await scanProfiles(options);
  const scanned = scan.profiles.find((candidate) => candidate.name === name);
  if (!scanned) {
    const near = scan.profiles
      .filter((candidate) => candidate.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, MAX_SUGGESTIONS);
    const suggestions =
      near.length > 0
        ? ` Closest known profiles: ${near.map((candidate) => candidate.name).join(", ")}.`
        : scan.profiles.length > 0
          ? ` Known profiles include: ${scan.profiles
              .slice(0, MAX_SUGGESTIONS)
              .map((candidate) => candidate.name)
              .join(", ")}.`
          : " No profiles were found in ~/.pi/agent/profiles or .pi/agent/profiles.";
    return {
      ok: false,
      error: `Unknown profile '${name}'.${suggestions}`,
    };
  }
  const agent = scanned.agent?.toLowerCase();
  if (agent !== undefined && !PROFILE_AGENTS.includes(agent as ProfileAgent)) {
    return {
      ok: false,
      error:
        `Profile '${name}' has agent: '${scanned.agent}', which is not one of: ` +
        `${PROFILE_AGENTS.join(", ")}.`,
    };
  }
  return {
    ok: true,
    profile: {
      name: scanned.name,
      agent: (agent as ProfileAgent) ?? "pi",
      ...(scanned.model ? { model: scanned.model } : {}),
      ...(scanned.thinkingLevel ? { thinkingLevel: scanned.thinkingLevel } : {}),
      body: scanned.body,
    },
  };
}
