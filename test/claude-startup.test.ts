import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeTrustSelection, waitForClaudeReady } from "../src/tools/claude-startup.js";

const DIALOG = [
  "Accessing workspace:",
  "/tmp/fresh-worktree",
  "Quick safety check: Is this a project you created or one you trust?",
  "❯ No, exit",
  "  Yes, I trust this folder",
  "Enter to confirm · Esc to cancel",
].join("\n");
const SELECTED_YES = DIALOG.replace("❯ No, exit", "  No, exit").replace(
  "  Yes, I trust this folder",
  "❯ Yes, I trust this folder",
);
const READY = "Claude Code\n❯\nbypass permissions on (shift+tab to cycle)";

describe("claudeTrustSelection", () => {
  it("handles either choice order and an already-selected Yes", () => {
    expect(claudeTrustSelection(DIALOG)).toBe(1);
    expect(claudeTrustSelection(SELECTED_YES)).toBe(0);
    expect(
      claudeTrustSelection(
        DIALOG.replace(
          "❯ No, exit\n  Yes, I trust this folder",
          "  1. Yes, I trust this folder\n❯ 2. No, exit",
        ),
      ),
    ).toBe(-1);
  });

  it("does not recognize other dialogs, ambiguous choices, or missing selection", () => {
    expect(claudeTrustSelection(READY)).toBeUndefined();
    expect(
      claudeTrustSelection(DIALOG.replace("Accessing workspace:", "Tool permission:")),
    ).toBeUndefined();
    expect(claudeTrustSelection(DIALOG.replace("❯", " "))).toBeUndefined();
    expect(
      claudeTrustSelection(DIALOG.replace("No, exit", "Yes, I trust this folder")),
    ).toBeUndefined();
    expect(claudeTrustSelection(DIALOG.replace("  Yes,", "❯ Yes,"))).toBeUndefined();
  });
});

function startup(
  screens: string[],
  settings: { accepted?: boolean; satisfied?: boolean; source?: string } = {},
) {
  const calls: string[][] = [];
  let reads = 0;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "read") {
      const screen = screens[Math.min(reads++, screens.length - 1)]!;
      return { terminal: { tail: screen.split("\n"), source: settings.source ?? "screen" } };
    }
    if (args[1] === "send") return { send: { accepted: settings.accepted ?? true } };
    if (args[1] === "wait") return { wait: { satisfied: settings.satisfied ?? true } };
    return {};
  };
  return { run, calls };
}

function options(run: ReturnType<typeof startup>["run"]) {
  return { run, handle: "child-1", totalMs: 1_000, runOptions: {}, notify: vi.fn() };
}

afterEach(() => vi.useRealTimers());

describe("waitForClaudeReady", () => {
  it("navigates to Yes, verifies the selected choice, and waits for idle after acceptance", async () => {
    const { run, calls } = startup([DIALOG, SELECTED_YES, READY, READY]);
    expect(await waitForClaudeReady(options(run))).toBe(true);
    const sends = calls.filter((args) => args[1] === "send");
    expect(sends).toEqual([
      ["terminal", "send", "--terminal", "child-1", "--text", "\u001b[B"],
      ["terminal", "send", "--terminal", "child-1", "--enter"],
    ]);
    const enter = calls.findIndex((args) => args.includes("--enter"));
    expect(calls.slice(enter + 1).some((args) => args[1] === "wait")).toBe(true);
  });

  it("waits for a delayed selection redraw without resending the arrow", async () => {
    const { run, calls } = startup([DIALOG, DIALOG, SELECTED_YES, READY, READY]);
    expect(await waitForClaudeReady(options(run))).toBe(true);
    expect(calls.filter((args) => args[1] === "send")).toEqual([
      ["terminal", "send", "--terminal", "child-1", "--text", "\u001b[B"],
      ["terminal", "send", "--terminal", "child-1", "--enter"],
    ]);
  });

  it("does not navigate when Yes is already selected", async () => {
    const { run, calls } = startup([SELECTED_YES, SELECTED_YES, READY, READY]);
    expect(await waitForClaudeReady(options(run))).toBe(true);
    expect(calls.filter((args) => args[1] === "send")).toEqual([
      ["terminal", "send", "--terminal", "child-1", "--enter"],
    ]);
  });

  it("never presses Enter if navigation failed or the dialog changed", async () => {
    for (const screen of [DIALOG, READY]) {
      const { run, calls } = startup([DIALOG, screen]);
      expect(await waitForClaudeReady(options(run))).toBe(false);
      expect(calls.some((args) => args.includes("--enter"))).toBe(false);
    }
  });

  it("stops when terminal input is rejected", async () => {
    const { run, calls } = startup([DIALOG], { accepted: false });
    expect(await waitForClaudeReady(options(run))).toBe(false);
    expect(calls.some((args) => args.includes("--enter"))).toBe(false);
  });

  it("does not accept the same dialog twice or treat it as ready", async () => {
    vi.useFakeTimers();
    const { run, calls } = startup([SELECTED_YES]);
    const base = options(run);
    const promise = waitForClaudeReady({
      ...base,
      run: async (args) => {
        if (args[1] === "wait") await vi.advanceTimersByTimeAsync(1_000);
        return base.run(args);
      },
    });
    expect(await promise).toBe(false);
    expect(calls.filter((args) => args[1] === "send")).toHaveLength(1);
  });

  it("checks the screen again if an idle probe returns while trust is appearing", async () => {
    const { run, calls } = startup([READY, SELECTED_YES, SELECTED_YES, SELECTED_YES, READY]);
    expect(await waitForClaudeReady(options(run))).toBe(true);
    expect(calls.some((args) => args.includes("--enter"))).toBe(true);
  });

  it("does not send input after cancellation", async () => {
    const { run, calls } = startup([DIALOG]);
    const controller = new AbortController();
    controller.abort();
    expect(
      await waitForClaudeReady({ ...options(run), runOptions: { signal: controller.signal } }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never acts on accumulated output instead of the rendered screen", async () => {
    const { run, calls } = startup([SELECTED_YES], { source: "stream" });
    expect(await waitForClaudeReady({ ...options(run), totalMs: 10 })).toBe(false);
    expect(calls.some((args) => args[1] === "send")).toBe(false);
  });

  it("does not mistake the initial idle shell for a ready Claude session", async () => {
    const { run, calls } = startup(["shell prompt", "shell prompt", DIALOG, SELECTED_YES, READY]);
    expect(await waitForClaudeReady(options(run))).toBe(true);
    expect(calls.some((args) => args.includes("--enter"))).toBe(true);
  });

  it("refuses readiness when Claude is still in auto mode", async () => {
    const { run, calls } = startup([READY.replace("bypass permissions on", "auto mode on")]);
    expect(await waitForClaudeReady({ ...options(run), totalMs: 10 })).toBe(false);
    expect(calls.some((args) => args[1] === "send")).toBe(false);
  });
});
