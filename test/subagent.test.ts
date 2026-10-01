import { describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../src/profiles.js";
import {
  composeTask,
  launchCommand,
  runSubagent,
  shq,
  subagentCallSegments,
  subagentDetailLines,
  subagentOutputSection,
  subagentStatusLine,
} from "../src/tools/subagent.js";

const TASK = "Review the diff and report findings.";
const PROFILES: Record<string, ResolvedProfile> = {
  known: { name: "known", agent: "pi", body: "You are a reviewer." },
  "codex-scout": {
    name: "codex-scout",
    agent: "codex",
    model: "gpt-6-sol",
    body: "You scout code.",
  },
  "claude-reviewer": { name: "claude-reviewer", agent: "claude", body: "You review code." },
};
const deps = {
  lookupProfile: async (name: string) =>
    name in PROFILES
      ? { ok: true, profile: PROFILES[name]! }
      : { ok: false, error: `Unknown profile '${name}'` },
  readinessTimeoutsMs: { first: 50, retry: 50 },
  sendProbe: { slices: 3, sliceMs: 30 },
  codexStartDelayMs: 1,
  codexQuietPoll: { pollMs: 1, quietMs: 1 },
};

/** Readiness and turn-start probes both use tui-idle waits, in this order:
 *  1 readiness probe → 1..n turn-start probes (must be busy) → completion polls.
 *  Sends report native turn observation (codex --wait-submit); `show`
 *  returns a frozen baseline stamp, then an older advanced stamp (quiet). */
function scriptedWait(sequence: Array<"READY" | "BUSY">) {
  const calls: string[][] = [];
  let waitIndex = 0;
  let showCount = 0;
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
    if (args[1] === "send")
      return { send: { accepted: true, prompt: { stages: ["input_accepted", "turn_started"] } } };
    if (args[1] === "show") {
      showCount++;
      return { terminal: { lastOutputAt: showCount === 1 ? 1_000 : 2_000 } };
    }
    if (args[1] === "read")
      return {
        terminal: {
          tail: ["Claude Code", "bypass permissions on", "DONE: 3 findings"],
          source: "screen",
        },
      };
    return {};
  };
  return { runner, calls };
}

describe("launchCommand", () => {
  it("runs pi with --agent-profile by default", () => {
    expect(launchCommand({ name: "known", agent: "pi", body: "b" })).toBe(
      "pi --agent-profile 'known'",
    );
  });

  it("launches codex bare or with the profile model", () => {
    expect(launchCommand({ name: "c", agent: "codex", body: "b" })).toBe("codex");
    expect(launchCommand({ name: "c", agent: "codex", model: "gpt-6-sol", body: "b" })).toBe(
      "codex --model 'gpt-6-sol'",
    );
  });

  it("forwards codex thinkingLevel as model_reasoning_effort, mapping off to none", () => {
    expect(
      launchCommand({
        name: "c",
        agent: "codex",
        model: "gpt-6-sol",
        thinkingLevel: "high",
        body: "b",
      }),
    ).toBe("codex --model 'gpt-6-sol' -c model_reasoning_effort=high");
    expect(launchCommand({ name: "c", agent: "codex", thinkingLevel: "off", body: "b" })).toBe(
      "codex -c model_reasoning_effort=none",
    );
  });

  it("launches claude with the body as --append-system-prompt, model forwarded", () => {
    expect(launchCommand({ name: "c", agent: "claude", model: "opus", body: "You review." })).toBe(
      "claude --dangerously-skip-permissions --model 'opus' --append-system-prompt 'You review.'",
    );
  });

  it("forwards claude thinkingLevel as --effort, clamping off/minimal to low", () => {
    expect(
      launchCommand({
        name: "c",
        agent: "claude",
        model: "opus",
        thinkingLevel: "high",
        body: "r",
      }),
    ).toBe(
      "claude --dangerously-skip-permissions --model 'opus' --effort high --append-system-prompt 'r'",
    );
    expect(launchCommand({ name: "c", agent: "claude", thinkingLevel: "off", body: "r" })).toBe(
      "claude --dangerously-skip-permissions --effort low --append-system-prompt 'r'",
    );
    expect(launchCommand({ name: "c", agent: "claude", thinkingLevel: "minimal", body: "r" })).toBe(
      "claude --dangerously-skip-permissions --effort low --append-system-prompt 'r'",
    );
    expect(launchCommand({ name: "c", agent: "claude", thinkingLevel: "max", body: "r" })).toBe(
      "claude --dangerously-skip-permissions --effort max --append-system-prompt 'r'",
    );
  });

  it("shell-quotes single quotes in values", () => {
    expect(shq("Blake's")).toBe("'Blake'\\''s'");
    expect(launchCommand({ name: "c", agent: "claude", body: "Blake's reviewer" })).toContain(
      `'Blake'\\''s reviewer'`,
    );
  });
});

describe("composeTask", () => {
  it("prepends the body for codex, which has no system-prompt flag", () => {
    expect(composeTask(PROFILES["codex-scout"]!, TASK)).toBe(`You scout code.\n\n---\n\n${TASK}`);
    expect(composeTask({ name: "c", agent: "codex", body: "" }, TASK)).toBe(TASK);
  });

  it("sends the task as-is for pi and claude", () => {
    expect(composeTask(PROFILES.known!, TASK)).toBe(TASK);
    expect(composeTask(PROFILES["claude-reviewer"]!, TASK)).toBe(TASK);
  });
});

describe("orca_subagent", () => {
  it("rejects unknown profiles before touching Orca", async () => {
    const { runner, calls } = scriptedWait(["READY"]);
    await expect(
      runSubagent({ profile: "nope", task: TASK }, { runOrca: runner, ...deps }),
    ).rejects.toThrow("Unknown profile 'nope'");
    expect(calls).toEqual([]);
  });

  it("rejects profiles with an unsupported agent value before touching Orca", async () => {
    const { runner, calls } = scriptedWait(["READY"]);
    const badAgent = {
      ...deps,
      lookupProfile: async () => ({
        ok: false,
        error: "Profile 'scout' has agent: 'gemini', which is not one of: pi, codex, claude.",
      }),
    };
    await expect(
      runSubagent({ profile: "scout", task: TASK }, { runOrca: runner, ...badAgent }),
    ).rejects.toThrow("agent: 'gemini'");
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
    expect(outcome.details.agent).toBe("pi");
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

  it("spawns codex with the model and rides the body on the first message", async () => {
    // Codex skips the idle gates (its tui-idle never reports at rest): a
    // fire-and-forget run makes no wait calls, and the single send carries
    // text, Enter, and --wait-submit (which observes the turn start).
    const { runner, calls } = scriptedWait(["READY"]);
    const outcome = await runSubagent(
      { profile: "codex-scout", task: TASK },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("started");
    expect(outcome.details.agent).toBe("codex");

    const create = calls.find((args) => args[0] === "terminal" && args[1] === "create");
    expect(create).toContain("codex --model 'gpt-6-sol'");
    const textSend = calls.find((args) => args[1] === "send" && args.includes("--text"));
    expect(textSend).toContain(`You scout code.\n\n---\n\n${TASK}`);
    expect(textSend).toContain("--enter");
    expect(textSend).toContain("--wait-submit");
    expect(calls.filter((args) => args[1] === "wait")).toHaveLength(0);
  });

  it("reports codex send-unverified when the turn start is not observed", async () => {
    const { runner } = scriptedWait(["READY"]);
    const withoutTurnStart = async (args: string[]) => {
      if (args[1] === "send")
        return { send: { accepted: true, prompt: { stages: ["input_accepted"] } } };
      return runner(args);
    };
    const outcome = await runSubagent(
      { profile: "codex-scout", task: TASK },
      { runOrca: withoutTurnStart, ...deps },
    );
    expect(outcome.details.status).toBe("send-unverified");
    expect(outcome.text).toContain("the turn start was not observed");
  });

  it("spawns claude with the body as --append-system-prompt and sends the bare task", async () => {
    const { runner, calls } = scriptedWait(["READY", "BUSY"]);
    const outcome = await runSubagent(
      { profile: "claude-reviewer", task: TASK },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("started");
    expect(outcome.details.agent).toBe("claude");

    const create = calls.find((args) => args[0] === "terminal" && args[1] === "create");
    expect(create).toContain(
      "claude --dangerously-skip-permissions --append-system-prompt 'You review code.'",
    );
    const textSend = calls.find((args) => args[1] === "send" && args.includes("--text"));
    expect(textSend).toContain(TASK);
    expect(textSend).not.toContain("You review code.");
  });

  it("waits for codex completion via the output-quiet watch", async () => {
    // No tui-idle at all: baseline show, then quiet polls until the output
    // stamp advances past the baseline and goes quiet.
    const { runner, calls } = scriptedWait(["READY"]);
    const outcome = await runSubagent(
      { profile: "codex-scout", task: TASK, wait: true, timeout_seconds: 30 },
      { runOrca: runner, ...deps },
    );
    expect(outcome.details.status).toBe("completed");
    expect(outcome.text).toContain("DONE: 3 findings");
    expect(calls.filter((args) => args[1] === "wait")).toHaveLength(0);
    expect(calls.filter((args) => args[1] === "show").length).toBeGreaterThanOrEqual(2);
  });

  it("reports codex still-running when output never goes quiet past the baseline", async () => {
    // Output stamp frozen at the baseline forever: the quiet watch exhausts
    // its budget and reports still-running with the screen as evidence.
    const { runner } = scriptedWait(["READY"]);
    const frozen = async (args: string[]) => {
      if (args[1] === "show") return { terminal: { lastOutputAt: 1_000 } };
      return runner(args);
    };
    const outcome = await runSubagent(
      { profile: "codex-scout", task: TASK, wait: true, timeout_seconds: 1 },
      { runOrca: frozen, ...deps, codexQuietPoll: { pollMs: 50, quietMs: 1 } },
    );
    expect(outcome.details.status).toBe("still-running");
    expect(outcome.text).toContain("still running after");
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
    const updates: string[] = [];
    const outcome = await runSubagent(
      { profile: "known", task: TASK, wait: true, timeout_seconds: 30 },
      { runOrca: runner, ...deps, onUpdate: (text) => updates.push(text) },
    );
    expect(outcome.details.status).toBe("completed");
    expect(outcome.text).toContain("DONE: 3 findings");
    // Progress ticks stream the elapsed time against the wait budget.
    expect(updates.some((text) => /Running… \d+s of 30s/.test(text))).toBe(true);
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
    expect(outcome.text).toContain("pi did not become ready");
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
    expect(outcome.text).toContain("the turn start was not observed");
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

describe("orca_subagent render data", () => {
  it("flags blocking calls with their wait budget", () => {
    const segments = subagentCallSegments({
      profile: "known",
      task: TASK,
      wait: true,
      timeout_seconds: 30,
    });
    const badge = segments.find((s) => s.text.includes("blocking"))!;
    expect(badge.color).toBe("warning");
    expect(badge.text).toContain("30s");
  });

  it("marks fire-and-forget calls async", () => {
    const segments = subagentCallSegments({ profile: "known", task: TASK });
    expect(segments.some((s) => s.text === "async" && s.color === "dim")).toBe(true);
  });

  it("labels worktree badges", () => {
    const newWt = subagentCallSegments({ profile: "known", task: TASK, worktree: "new" });
    expect(newWt.some((s) => s.text === "new worktree")).toBe(true);
    const path = subagentCallSegments({ profile: "known", task: TASK, worktree: "path:/repo" });
    expect(path.some((s) => s.text === "worktree path:/repo")).toBe(true);
    const active = subagentCallSegments({ profile: "known", task: TASK, worktree: "active" });
    expect(active.some((s) => s.text.includes("worktree"))).toBe(false);
  });

  it("summarizes each outcome with a symbol and color", () => {
    expect(subagentStatusLine({ status: "completed", elapsedSeconds: 12 })).toMatchObject({
      symbol: "✓",
      color: "success",
      text: "finished after 12s",
    });
    expect(subagentStatusLine({ status: "started" })).toMatchObject({
      symbol: "▶",
      color: "accent",
    });
    expect(subagentStatusLine({ status: "still-running", elapsedSeconds: 600 })).toMatchObject({
      symbol: "⏳",
      color: "warning",
    });
    expect(subagentStatusLine({ status: "aborted" })).toMatchObject({ color: "warning" });
    expect(subagentStatusLine({ status: "send-failed" })).toMatchObject({ color: "error" });
    expect(subagentStatusLine({ status: "not-started" })).toMatchObject({ color: "error" });
  });

  it("extracts detail lines and the screen output for the expanded view", () => {
    expect(
      subagentDetailLines({
        title: "known:review-the-diff",
        profile: "known",
        agent: "codex",
        worktree: "active worktree",
        elapsedSeconds: 3,
      }),
    ).toEqual([
      "title: known:review-the-diff",
      "profile: known",
      "agent: codex",
      "worktree: active worktree",
      "elapsed: 3s",
    ]);
    // pi is the default and stays silent.
    expect(subagentDetailLines({ profile: "known", agent: "pi" })).toEqual(["profile: known"]);
    const body =
      "Subagent 'known' finished after 3s. Terminal t.\n--- output (screen) ---\nline1\nline2";
    expect(subagentOutputSection(body)).toBe("line1\nline2");
    expect(subagentOutputSection("no output here")).toBeUndefined();
  });
});
