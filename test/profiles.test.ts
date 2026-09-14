import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatterName, scanProfileNames, validateProfileName } from "../src/profiles.js";

describe("parseFrontmatterName", () => {
  it("reads the name field, quoted or bare", () => {
    expect(parseFrontmatterName("---\nname: scout\n---\nbody")).toBe("scout");
    expect(parseFrontmatterName('---\nname: "quoted name"\n---\n')).toBe("quoted name");
    expect(parseFrontmatterName("---\ntitle: x\n---\n")).toBeUndefined();
    expect(parseFrontmatterName("no frontmatter")).toBeUndefined();
    expect(parseFrontmatterName("---\nname:\n---\n")).toBeUndefined();
  });
});

describe("scanProfileNames", () => {
  it("merges global and trusted project dirs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orca-profiles-"));
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"), { recursive: true });
    await mkdir(join(cwd, ".pi", "agent", "profiles"), { recursive: true });
    await writeFile(join(agentDir, "profiles", "reviewer.md"), "---\nname: reviewer\n---\n");
    await writeFile(
      join(cwd, ".pi", "agent", "profiles", "local.md"),
      "---\nname: local-scout\n---\n",
    );
    await writeFile(join(cwd, ".pi", "agent", "profiles", "noname.md"), "no frontmatter");

    const scan = await scanProfileNames({
      cwd,
      projectTrusted: true,
      agentDir,
    });
    expect(scan.names).toEqual(["local-scout", "reviewer"]);

    // Untrusted projects contribute nothing.
    const untrusted = await scanProfileNames({ cwd, projectTrusted: false, agentDir });
    expect(untrusted.names).toEqual(["reviewer"]);
  });

  it("ignores a missing home directory without failing", async () => {
    const scan = await scanProfileNames({
      agentDir: join(homedir(), ".pi", "does-not-exist"),
    });
    expect(scan.names).toEqual([]);
  });
});

describe("validateProfileName", () => {
  it("accepts a known name", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"));
    await writeFile(join(agentDir, "profiles", "reviewer.md"), "---\nname: reviewer\n---\n");
    const result = await validateProfileName("reviewer", { agentDir });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown name with suggestions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "orca-agent-"));
    await mkdir(join(agentDir, "profiles"));
    await writeFile(join(agentDir, "profiles", "reviewer.md"), "---\nname: reviewer\n---\n");
    const result = await validateProfileName("reviwer", { agentDir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown profile 'reviwer'");
    expect(result.error).toContain("reviewer");
  });
});
