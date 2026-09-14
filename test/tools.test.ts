import { describe, expect, it } from "vitest";
import { buildBrowserArgs, extractImage, registerOrcaBrowserTool } from "../src/tools/browser.js";
import { registerOrcaTabsTool } from "../src/tools/tabs.js";
import {
  registerOrcaTerminalTool,
  selectTerminal,
  type OrcaTerminalInfo,
} from "../src/tools/terminal.js";
import { resolveWorktreeSelector, extractTerminalHandle } from "../src/tools/subagent.js";
import { clipHead, clipTail, orcaErrorMessage, slugify, textResult } from "../src/util.js";
import { OrcaCliError } from "../src/orca-cli.js";

const terminals: OrcaTerminalInfo[] = [
  { handle: "t1", title: "π - pi-orca", worktreePath: "/repo/pi-orca" },
  { handle: "t2", title: "scout:auth", worktreePath: "/repo/other" },
  { handle: "t3", title: "scout:docs", worktreePath: "/repo/third" },
];

describe("selectTerminal", () => {
  it("defers to Orca when no selector is given", () => {
    expect(selectTerminal(terminals, undefined)).toEqual({});
    expect(selectTerminal(terminals, "")).toEqual({});
  });

  it("matches by exact handle, unique title, and 1-based index", () => {
    expect(selectTerminal(terminals, "t2")).toEqual({ handle: "t2" });
    expect(selectTerminal(terminals, "scout:auth")).toEqual({ handle: "t2" });
    expect(selectTerminal(terminals, "3")).toEqual({ handle: "t3" });
  });

  it("rejects ambiguity and out-of-range indexes with helpful errors", () => {
    const ambiguous = selectTerminal(terminals, "scout");
    expect("error" in ambiguous && ambiguous.error).toContain("multiple terminals");
    const missing = selectTerminal(terminals, "nope");
    expect("error" in missing && missing.error).toContain("No terminal matches");
    const range = selectTerminal(terminals, "9");
    expect("error" in range && range.error).toContain("out of range");
  });
});

describe("buildBrowserArgs", () => {
  it("maps every action to orca argv", () => {
    expect(buildBrowserArgs({ action: "open", url: "https://x.test" }).args).toEqual([
      "tab",
      "create",
      "--url",
      "https://x.test",
    ]);
    expect(buildBrowserArgs({ action: "goto", url: "https://x.test" }).args).toEqual([
      "goto",
      "--url",
      "https://x.test",
    ]);
    expect(buildBrowserArgs({ action: "snapshot" }).args).toEqual(["snapshot"]);
    expect(buildBrowserArgs({ action: "click", ref: "e3" }).args).toEqual([
      "click",
      "--element",
      "e3",
    ]);
    expect(buildBrowserArgs({ action: "fill", ref: "e3", value: "hi" }).args).toEqual([
      "fill",
      "--element",
      "e3",
      "--value",
      "hi",
    ]);
    expect(buildBrowserArgs({ action: "type", text: "hello" }).args).toEqual([
      "type",
      "--input",
      "hello",
    ]);
    expect(buildBrowserArgs({ action: "key", key: "Enter" }).args).toEqual([
      "keypress",
      "--key",
      "Enter",
    ]);
    expect(buildBrowserArgs({ action: "scroll", direction: "down", amount: 500 }).args).toEqual([
      "scroll",
      "--direction",
      "down",
      "--amount",
      "500",
    ]);
    expect(buildBrowserArgs({ action: "wait", text: "Ready", timeout_ms: 4000 }).args).toEqual([
      "wait",
      "--text",
      "Ready",
      "--timeout",
      "4000",
    ]);
    expect(buildBrowserArgs({ action: "wait", load_state: "load" }).args).toEqual([
      "wait",
      "--load",
      "load",
    ]);
    expect(buildBrowserArgs({ action: "close", index: 2 }).args).toEqual([
      "tab",
      "close",
      "--index",
      "2",
    ]);
    expect(buildBrowserArgs({ action: "screenshot", format: "png" }).args).toEqual([
      "screenshot",
      "--format",
      "png",
    ]);
  });

  it("reports missing required params instead of argv", () => {
    expect(buildBrowserArgs({ action: "click" }).error).toContain("ref");
    expect(buildBrowserArgs({ action: "fill", ref: "e1" }).error).toContain("value");
    expect(buildBrowserArgs({ action: "goto" }).error).toContain("url");
    expect(buildBrowserArgs({ action: "close" }).error).toContain("index");
    expect(buildBrowserArgs({ action: "wait" }).error).toContain("wait requires");
  });
});

describe("screenshot and worktree result extraction", () => {
  it("extracts base64 images from screenshot results", () => {
    expect(extractImage({ data: "aGVsbG8=", mimeType: "image/png" })).toEqual({
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(extractImage({ screenshot: { base64: "abc" } })).toEqual({
      data: "abc",
      mimeType: "image/jpeg",
    });
    expect(extractImage({ nope: 1 })).toBeUndefined();
    expect(extractImage("plain")).toBeUndefined();
  });

  it("reads terminal handles and worktree selectors defensively", () => {
    expect(extractTerminalHandle({ startupTerminal: { handle: "t9" } })).toBe("t9");
    expect(extractTerminalHandle({ terminal: { handle: "t8" } })).toBe("t8");
    expect(extractTerminalHandle({ handle: "t7" })).toBe("t7");
    expect(extractTerminalHandle({ unexpected: true })).toBeUndefined();
    expect(resolveWorktreeSelector({ worktree: { worktreeId: "r::/p" } })).toBe("id:r::/p");
    expect(resolveWorktreeSelector({ worktreeId: "r::/p" })).toBe("id:r::/p");
    expect(resolveWorktreeSelector({ path: "/repo" })).toBe("path:/repo");
    expect(resolveWorktreeSelector(null)).toBeUndefined();
  });
});

describe("util", () => {
  it("clips output with clear markers", () => {
    expect(clipTail("short")).toBe("short");
    expect(clipTail("x".repeat(30), 10)).toContain("truncated 20 leading characters");
    expect(clipHead("y".repeat(30), 10)).toContain("truncated 20 trailing characters");
  });
  it("slugifies titles", () => {
    expect(slugify("Review the auth module!!")).toBe("review-the-auth-module");
    expect(slugify("///")).toBe("task");
  });
  it("formats orca errors with a running hint", () => {
    expect(orcaErrorMessage(new OrcaCliError("unavailable", "not found"))).toContain(
      "check that the Orca app is running",
    );
    expect(orcaErrorMessage(new OrcaCliError("failed", "nope"))).toBe("nope");
    expect(orcaErrorMessage(new Error("other"))).toBe("other");
  });
  it("textResult always carries details", () => {
    expect(textResult("hi")).toEqual({
      content: [{ type: "text", text: "hi" }],
      details: {},
    });
  });
});

/** Register tools against a recording stub and return the captured definitions. */
function captureTools(
  register: (pi: never, deps?: never) => void,
): Map<string, { execute: (...args: unknown[]) => unknown }> {
  const definitions = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  const pi = {
    registerTool: (definition: { name: string; execute: (...args: unknown[]) => unknown }) => {
      definitions.set(definition.name, definition);
    },
  };
  register(pi as never, undefined as never);
  return definitions;
}

describe("tool execute paths", () => {
  it("orca_terminal read renders the tail through the injected runner", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return args[1] === "list"
        ? { terminals: [{ handle: "t1", title: "x" }] }
        : { terminal: { tail: ["out", "lines"], source: "stream" } };
    };
    const tools = captureTools((pi: never) =>
      registerOrcaTerminalTool(pi as never, { runOrca: runner as never }),
    );
    const execute = tools.get("orca_terminal")!.execute;
    const result = (await execute(
      "id",
      { action: "read", terminal: "t1" },
      undefined,
      undefined,
    )) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("out\nlines");
    expect(calls[0]).toEqual(["terminal", "list"]);
    expect(calls[1]).toEqual(["terminal", "read", "--terminal", "t1", "--limit", "400"]);
  });

  it("orca_terminal send passes text and enter flags", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return args[0] === "terminal" && args[1] === "list"
        ? { terminals: [{ handle: "t1", title: "x" }] }
        : { delivery: "input_accepted" };
    };
    const tools = captureTools((pi: never) =>
      registerOrcaTerminalTool(pi as never, { runOrca: runner as never }),
    );
    await executeTool(tools, "orca_terminal", {
      action: "send",
      terminal: "t1",
      text: "hello",
      wait_submit_seconds: 5,
    });
    expect(calls[1]).toEqual([
      "terminal",
      "send",
      "--terminal",
      "t1",
      "--text",
      "hello",
      "--enter",
      "--wait-submit",
      "5",
    ]);
  });

  it("orca_terminal wait streams ticks and reports satisfaction", async () => {
    let waits = 0;
    const runner = async (args: string[]) => {
      if (args[1] === "wait") {
        waits++;
        return { wait: { satisfied: waits >= 3, condition: "tui-idle" } };
      }
      return { terminals: [{ handle: "t1" }] };
    };
    const tools = captureTools((pi: never) =>
      registerOrcaTerminalTool(pi as never, { runOrca: runner as never }),
    );
    const result = (await executeTool(tools, "orca_terminal", {
      action: "wait",
      terminal: "t1",
      timeout_seconds: 30,
    })) as { content: { text: string }[]; details: { satisfied?: boolean } };
    expect(waits).toBe(3);
    expect(result.details.satisfied).toBe(true);
  }, 20_000);

  it("orca_tabs lists terminals and closes one by index", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return args[1] === "list"
        ? { terminals: [{ handle: "t1", title: "only" }] }
        : { closed: true };
    };
    const tools = captureTools((pi) => registerOrcaTabsTool(pi, { runOrca: runner }));
    const listed = (await executeTool(tools, "orca_tabs", {
      kind: "terminal",
      action: "list",
    })) as { content: { text: string }[] };
    expect(listed.content[0]!.text).toContain("t1");
    const closed = (await executeTool(tools, "orca_tabs", {
      kind: "terminal",
      action: "close",
      target: "1",
    })) as { content: { text: string }[] };
    expect(closed.content[0]!.text).toContain("Closed terminal t1");
    expect(calls.at(-1)).toEqual(["terminal", "close", "--terminal", "t1"]);
  });

  it("orca_browser executes a snapshot and surfaces missing params", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return { snapshot: "tree" };
    };
    const tools = captureTools((pi) => registerOrcaBrowserTool(pi, { runOrca: runner }));
    const result = (await executeTool(tools, "orca_browser", {
      action: "snapshot",
    })) as { content: { text: string }[] };
    expect(calls[0]).toEqual(["snapshot"]);
    expect(result.content[0]!.text).toContain("tree");
    await expect(executeTool(tools, "orca_browser", { action: "click" })).rejects.toThrow("ref");
  });
});

/** Small helper: pull execute out of the captured map. */
function executeTool(
  tools: Map<string, { execute: (...args: unknown[]) => unknown }>,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return Promise.resolve(tools.get(name)!.execute("call-id", params, undefined, undefined));
}
