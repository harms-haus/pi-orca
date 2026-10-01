/** Live Claude startup regression: fresh untrusted Git and non-Git folders.
 * Runs real agents and tools, verifies their written artifacts, and closes
 * only the tabs it creates. Run with pnpm exec jiti scripts/e2e-claude.ts. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrca } from "../src/orca-cli.js";
import { extractTerminalHandle, runSubagent, shq } from "../src/tools/subagent.js";

for (const kind of ["git", "folder"]) {
  const cwd = await mkdtemp(join(tmpdir(), `pi-orca-claude-${kind}-`));
  let handle: string | undefined;
  try {
    if (kind === "git") execFileSync("git", ["init", "--quiet", cwd]);
    const marker = `CLAUDE-BYPASS-OK-${kind}`;
    const outcome = await runSubagent(
      {
        profile: "claude-startup-probe",
        title: `claude-startup-${kind}`,
        task: `Use your tools to write proof.txt in the current directory containing exactly ${marker}, with no newline. Then reply with exactly ${marker}. Do not touch any other files.`,
        wait: true,
        timeout_seconds: 90,
      },
      {
        lookupProfile: async () => ({
          ok: true,
          profile: {
            name: "claude-startup-probe",
            agent: "claude",
            body: "You are a startup verification agent. Follow the task exactly.",
          },
        }),
        runOrca: async (args, options) => {
          // Keep the IDE tab in the active worktree, but run Claude inside
          // a never-before-used folder so cached trust cannot hide regressions.
          const commandIndex = args.indexOf("--command");
          const actual = [...args];
          if (args[1] === "create" && commandIndex !== -1) {
            actual[commandIndex + 1] = `cd ${shq(cwd)} && ${args[commandIndex + 1]}`;
          }
          const result = await runOrca(actual, options);
          if (args[1] === "create") handle = extractTerminalHandle(result);
          return result;
        },
        onUpdate: (text) => console.log(`[${kind}] ${text}`),
      },
    );
    if (outcome.details.status !== "completed" && outcome.details.status !== "send-unverified") {
      throw new Error(`${kind}: startup or task failed\n${outcome.text}`);
    }
    if ((await readFile(join(cwd, "proof.txt"), "utf8")) !== marker) {
      throw new Error(`${kind}: incorrect proof.txt`);
    }
    if (!outcome.text.includes("bypass permissions on")) {
      throw new Error(`${kind}: bypass mode was not visible in the final screen`);
    }
    if (!outcome.text.includes(marker)) throw new Error(`${kind}: response marker missing`);
    console.log(
      `${kind}: PASS, artifact verified, bypass mode visible, status=${outcome.details.status}`,
    );
  } finally {
    if (handle) await runOrca(["terminal", "close", "--terminal", handle]);
    await rm(cwd, { recursive: true, force: true });
  }
}
