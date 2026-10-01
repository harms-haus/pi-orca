import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookupProfile, parseProfileFrontmatter, scanProfiles } from "../src/profiles.js";

describe("parseProfileFrontmatter", () => {
  it("reads name, agent, model, and thinkingLevel, quoted or bare, plus the body", () => {
    expect(
      parseProfileFrontmatter(
        '---\nname: scout\nagent: "codex"\nmodel: gpt-6-sol\nthinkingLevel: high\n---\nYou are a scout.',
      ),
    ).toEqual({
      name: "scout",
      agent: "codex",
      model: "gpt-6-sol",
      thinkingLevel: "high",
      body: "You are a scout.",
    });
  });

  it("ignores a thinkingLevel that is not one of the canonical levels", () => {
    expect(parseProfileFrontmatter("---\nname: s\nthinkingLevel: turbo\n---\nb")).toEqual({
      name: "s",
      body: "b",
    });
  });

  it("omits absent fields and returns the whole text as body without frontmatter", () => {
    expect(parseProfileFrontmatter("---\nname: scout\n---\nbody")).toEqual({
      name: "scout",
      body: "body",
    });
    expect(parseProfileFrontmatter("no frontmatter")).toEqual({ body: "no frontmatter" });
    expect(parseProfileFrontmatter("---\nname:\n---\n")).toEqual({ body: "" });
    expect(parseProfileFrontmatter('---\nname: "quoted name"\n---\n')).toEqual({
      name: "quoted name",
      body: "",
    });
  });
});

describe("scanProfiles", () => {
  it("merges global and trusted project dirs, with project shadowing global", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orca-profiles-"));
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"), { recursive: true });
    await mkdir(join(cwd, ".pi", "agent", "profiles"), { recursive: true });
    await writeFile(
      join(agentDir, "profiles", "reviewer.md"),
      "---\nname: reviewer\nagent: claude\n---\nYou review code.",
    );
    await writeFile(
      join(agentDir, "profiles", "shadowed.md"),
      "---\nname: shadowed\n---\nGlobal body.",
    );
    await writeFile(
      join(cwd, ".pi", "agent", "profiles", "local.md"),
      "---\nname: local-scout\nagent: codex\nmodel: gpt-6-sol\n---\nYou scout.",
    );
    await writeFile(
      join(cwd, ".pi", "agent", "profiles", "shadowed.md"),
      "---\nname: shadowed\n---\nProject body.",
    );
    await writeFile(join(cwd, ".pi", "agent", "profiles", "noname.md"), "no frontmatter");

    const scan = await scanProfiles({ cwd, projectTrusted: true, agentDir });
    expect(scan.profiles.map((p) => p.name)).toEqual(["local-scout", "reviewer", "shadowed"]);
    expect(scan.profiles.find((p) => p.name === "reviewer")).toMatchObject({
      agent: "claude",
      body: "You review code.",
    });
    expect(scan.profiles.find((p) => p.name === "local-scout")).toMatchObject({
      agent: "codex",
      model: "gpt-6-sol",
    });
    // Project profile with the same name wins.
    expect(scan.profiles.find((p) => p.name === "shadowed")?.body).toBe("Project body.");

    // Untrusted projects contribute nothing.
    const untrusted = await scanProfiles({ cwd, projectTrusted: false, agentDir });
    expect(untrusted.profiles.map((p) => p.name)).toEqual(["reviewer", "shadowed"]);
  });

  it("ignores a missing home directory without failing", async () => {
    const scan = await scanProfiles({
      agentDir: join(homedir(), ".pi", "does-not-exist"),
    });
    expect(scan.profiles).toEqual([]);
  });
});

describe("lookupProfile", () => {
  it("resolves a known name, defaulting agent to pi", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"));
    await writeFile(join(agentDir, "profiles", "reviewer.md"), "---\nname: reviewer\n---\nBody.");
    const result = await lookupProfile("reviewer", { agentDir });
    expect(result).toEqual({ ok: true, profile: { name: "reviewer", agent: "pi", body: "Body." } });
  });

  it("normalizes the agent value case-insensitively and forwards the model", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"));
    await writeFile(
      join(agentDir, "profiles", "scout.md"),
      "---\nname: scout\nagent: Claude\nmodel: opus\nthinkingLevel: xhigh\n---\nBody.",
    );
    const result = await lookupProfile("scout", { agentDir });
    expect(result.profile).toMatchObject({
      agent: "claude",
      model: "opus",
      thinkingLevel: "xhigh",
    });
  });

  it("rejects an unknown agent value", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"));
    await writeFile(
      join(agentDir, "profiles", "reviewer.md"),
      "---\nname: reviewer\nagent: gemini\n---\nBody.",
    );
    const result = await lookupProfile("reviewer", { agentDir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("agent: 'gemini'");
    expect(result.error).toContain("pi, codex, claude");
  });

  it("rejects an unknown name with suggestions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"));
    await writeFile(join(agentDir, "profiles", "reviewer.md"), "---\nname: reviewer\n---\n");
    const result = await lookupProfile("reviwer", { agentDir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown profile 'reviwer'");
    expect(result.error).toContain("reviewer");
  });
});
