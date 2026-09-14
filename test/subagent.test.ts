import { describe, expect, it } from "vitest";
import { runSubagent } from "../src/tools/subagent.js";

const okProfile = async (name: string) =>
  name === "known" ? { ok: true } : { ok: false, error: `Unknown profile '${name}'` };
const deps = {
  validateProfile: okProfile,
  readinessTimeoutsMs: { first: 50, retry: 50 },
  sendProbe: { slices: 3, sliceMs: 30 },
};

const TASK = "Review the diff and report findings.";
/** Readiness and turn-start probes both use tui-idle waits, in this order:
 *  1 readiness probe → 1..n turn-start probes (must be busy) → completion polls. */
function scriptedWait(sequence: Array<"READY" | "BUSY">) {
  const calls: string[][] = [];
  let waitIndex = 0;
  const runner = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "wait") {
      const state = sequence[Math.min(waitIndex, sequence.length - 1)];
      waitIndex++;
      return state === "READY"
        ? { wait: { satisfied: true, condition: "tui-idle", status: "running" } }
        : { wait: { satisfied: false, condition: "tui-idle", status: "running" } };
    }
    if (args[0] === "worktree") return { worktree: { worktreeId: "repo1::/repo/wt" } };
    if (args[1] === "create") return { startupTerminal: { handle: "child-1" } };
    if (args[1] === "send") return { send: { accepted: true } };
    if (args[1] === "read") return { terminal: { tail: ["DONE: 3 findings"], source: "screen" } };
    return {};
  };
  return { runner, calls };
}

describe("orca_subagent", () => {
  it("rejects unknown profiles before touching Orca", async () => {
    const { runner, calls } = scriptedWait(["READY"]);
    await expect(
      runSubagent({ profile: "nope", task: TASK }, { runOrca: runner, ...deps }),
    ).rejects.toThrow("Unknown profile 'nope'");
    expect(calls).toEqual([]);
  });

  it("spawns, sends, and returns the handle without waiting", async () => {
    // Readiness satisfied, then the agent goes busy (turn started).
    const { runner, calls } = scriptedWait(["READY", "BUSY"]);
    const outcome = await runSubagent(
      { profile: "known", task: TASK },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("started");
    expect(outcome.details.terminal).toBe("child-1");
    expect(outcome.text).toContain("Monitor it with orca_terminal");

    const create = calls.find((args) => args[0] === "terminal" && args[1] === "create");
    expect(create).toContain("--command");
    expect(create).toContain("pi --agent-profile 'known'");
    const sends = calls.filter((args) => args[1] === "send");
    expect(sends[0]).toContain(TASK);
    // Enter is a separate keystroke: a fast text+Enter burst reads as one
    // paste in pi's editor and never submits.
    expect(sends.at(-1)).not.toContain(TASK);
    expect(sends.every((args) => !args.includes("--wait-submit"))).toBe(true);
  });

  it("creates a child worktree when worktree=new", async () => {
    const { runner, calls } = scriptedWait(["READY", "BUSY"]);
    await runSubagent(
      { profile: "known", task: TASK, worktree: "new" },
      { runOrca: runner, ...deps },
    );
    const worktreeCreate = calls.find((args) => args[0] === "worktree")!;
    expect(worktreeCreate).toEqual(["worktree", "create", "--name", expect.any(String)]);
    const terminalCreate = calls.find((args) => args[0] === "terminal" && args[1] === "create")!;
    const wtIndex = terminalCreate.indexOf("--worktree");
    expect(terminalCreate[wtIndex + 1]).toBe("id:repo1::/repo/wt");
  });

  it("waits for completion and returns screen output", async () => {
    // Ready → busy (turn start) → busy (working) → idle (done).
    const { runner } = scriptedWait(["READY", "BUSY", "BUSY", "READY"]);
    const outcome = await runSubagent(
      { profile: "known", task: TASK, wait: true, timeout_seconds: 30 },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("completed");
    expect(outcome.text).toContain("DONE: 3 findings");
  });

  it("reports still-running with output when the timeout elapses", async () => {
    // Ready → busy (turn start) → busy forever.
    const { runner } = scriptedWait(["READY", "BUSY"]);
    const outcome = await runSubagent(
      { profile: "known", task: TASK, wait: true, timeout_seconds: 2 },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("still-running");
    expect(outcome.text).toContain("still running after");
  });

  it("reports not-started when readiness never arrives", async () => {
    const { runner, calls } = scriptedWait(["BUSY"]);
    const outcome = await runSubagent(
      { profile: "known", task: TASK },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("not-started");
    expect(outcome.text).toContain("Nothing was sent");
    expect(calls.filter((args) => args[1] === "send")).toHaveLength(0);
  });

  it("reports send-unverified when the agent never goes busy", async () => {
    // Idle forever after an accepted send.
    const { runner } = scriptedWait(["READY", "READY", "READY", "READY"]);
    const outcome = await runSubagent(
      { profile: "known", task: TASK },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("send-unverified");
    expect(outcome.text).toContain("never went busy");
  });

  it("reports send-failed when the terminal rejects input", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "wait") return { wait: { satisfied: true } };
      if (args[1] === "create") return { startupTerminal: { handle: "child-1" } };
      if (args[1] === "send") return { send: { accepted: false } };
      return {};
    };
    const outcome = await runSubagent(
      { profile: "known", task: TASK },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("send-failed");
    expect(calls.filter((args) => args[1] === "send")).toHaveLength(1);
  });

  it("rejects invalid worktree selectors", async () => {
    const { runner } = scriptedWait(["READY"]);
    await expect(
      runSubagent(
        { profile: "known", task: TASK, worktree: "not-a-selector" },
        { runOrca: runner, ...deps },
      ),
    ).rejects.toThrow("Invalid worktree selector");
  });
});
