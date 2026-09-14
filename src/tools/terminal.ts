import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runOrca, type OrcaRunOptions } from "../orca-cli.js";
import { clipTail, orcaErrorMessage, renderResult, textResult } from "../util.js";

export interface OrcaTerminalInfo {
  handle: string;
  title?: string;
  worktreePath?: string;
  branch?: string;
  connected?: boolean;
  orphaned?: boolean;
  status?: string;
  lastOutputAt?: number;
  preview?: string;
  agentIdentity?: string;
}

export interface OrcaTerminalDeps {
  runOrca?: typeof runOrca;
}

export async function listTerminals(
  run: typeof runOrca,
  options?: OrcaRunOptions,
): Promise<OrcaTerminalInfo[]> {
  const result = (await run(["terminal", "list"], options)) as
    | { terminals?: OrcaTerminalInfo[] }
    | undefined;
  return result?.terminals ?? [];
}

export type TerminalSelection = { handle?: string } | { error: string };

/**
 * Resolve a user selector against a listing: exact handle, unique
 * case-insensitive title substring, or 1-based index. No selector defers to
 * Orca's active-terminal default.
 */
export function selectTerminal(
  terminals: readonly OrcaTerminalInfo[],
  selector?: string,
): TerminalSelection {
  if (selector === undefined || selector.trim() === "") return {};
  const needle = selector.trim();
  const exact = terminals.find((terminal) => terminal.handle === needle);
  if (exact?.handle) return { handle: exact.handle };
  if (/^\d+$/.test(needle)) {
    const index = Number.parseInt(needle, 10);
    const picked = terminals[index - 1];
    if (!picked?.handle) {
      return {
        error: `Terminal index ${index} is out of range; the listing has ${terminals.length}.`,
      };
    }
    return { handle: picked.handle };
  }
  const matches = terminals.filter(
    (terminal) =>
      terminal.title !== undefined && terminal.title.toLowerCase().includes(needle.toLowerCase()),
  );
  if (matches.length === 1) return { handle: matches[0]!.handle };
  if (matches.length === 0) {
    const titles = terminals
      .map((terminal) => `${terminal.handle} ${terminal.title ?? "(untitled)"}`)
      .slice(0, 8)
      .join("\n");
    return { error: `No terminal matches '${needle}'. Open terminals:\n${titles}` };
  }
  const ambiguous = matches
    .map((terminal) => `${terminal.handle} ${terminal.title ?? "(untitled)"}`)
    .join("\n");
  return { error: `'${needle}' matches multiple terminals; use a handle:\n${ambiguous}` };
}

/** Read the rendered screen of a terminal (TUI-safe), capped and trimmed. */
export async function readTerminalScreen(
  run: typeof runOrca,
  handle: string | undefined,
  runOptions: OrcaRunOptions,
  limit = 400,
): Promise<{ text: string; source?: string }> {
  const result = (await run(
    [
      "terminal",
      "read",
      ...(handle ? ["--terminal", handle] : []),
      "--screen",
      "--limit",
      String(limit),
    ],
    runOptions,
  )) as { terminal?: { tail?: string[]; source?: string } } | undefined;
  const tail = result?.terminal?.tail ?? [];
  return {
    text: clipTail(tail.join("\n")),
    ...(result?.terminal?.source ? { source: result.terminal.source } : {}),
  };
}

/** One `terminal wait` probe, bounded by sliceMs. */
export async function waitOnce(
  run: typeof runOrca,
  handle: string | undefined,
  condition: "tui-idle" | "exit",
  sliceMs: number,
  options?: OrcaRunOptions,
): Promise<{ satisfied: boolean; status?: string; exitCode?: number | null }> {
  const result = (await run(
    [
      "terminal",
      "wait",
      ...(handle ? ["--terminal", handle] : []),
      "--for",
      condition,
      "--timeout-ms",
      String(sliceMs),
    ],
    { ...options, timeoutMs: sliceMs + 15_000, timeoutOk: true },
  )) as { wait?: { satisfied?: boolean; status?: string; exitCode?: number | null } } | undefined;
  const wait = result?.wait;
  return {
    satisfied: wait?.satisfied === true,
    ...(wait?.status !== undefined ? { status: wait.status } : {}),
    ...(wait?.exitCode !== undefined ? { exitCode: wait.exitCode } : {}),
  };
}

/**
 * Poll `terminal wait` in short slices so progress updates stream to the
 * caller and aborts land within one slice.
 */
export async function waitUntilIdle(options: {
  run: typeof runOrca;
  handle?: string;
  condition?: "tui-idle" | "exit";
  totalMs: number;
  sliceMs?: number;
  runOptions?: OrcaRunOptions;
  onTick?: (elapsedMs: number) => void;
}): Promise<{ satisfied: boolean; elapsedMs: number; status?: string }> {
  const condition = options.condition ?? "tui-idle";
  const sliceMs = options.sliceMs ?? 3_000;
  const started = Date.now();
  let last: Awaited<ReturnType<typeof waitOnce>> = { satisfied: false };
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= options.totalMs) return { ...last, elapsedMs: elapsed };
    if (options.runOptions?.signal?.aborted) {
      return { ...last, elapsedMs: Date.now() - started };
    }
    last = await waitOnce(options.run, options.handle, condition, sliceMs, options.runOptions);
    if (last.satisfied) return { ...last, elapsedMs: Date.now() - started };
    options.onTick?.(Date.now() - started);
  }
}

export function registerOrcaTerminalTool(pi: ExtensionAPI, deps: OrcaTerminalDeps = {}): void {
  const run = deps.runOrca ?? runOrca;

  pi.registerTool({
    name: "orca_terminal",
    label: "Orca Terminal",
    description:
      "Read output from, send input to, or wait on an Orca IDE terminal session. " +
      "Targets the active terminal when `terminal` is omitted; otherwise match a terminal " +
      "by handle, unique title substring, or 1-based index from the `orca_terminal` list " +
      "ordering (use orca_tabs action=list to see it). Subagents spawned with orca_subagent " +
      "are ordinary terminals: read their output and send follow-up messages here.",
    promptSnippet: "Read/send/wait on Orca IDE terminal sessions (incl. subagents)",
    promptGuidelines: [
      "Use orca_terminal action=read after orca_subagent wait:true reports still-running, to check subagent progress.",
    ],
    parameters: Type.Object({
      action: StringEnum(["read", "send", "wait"] as const),
      terminal: Type.Optional(
        Type.String({ description: "Handle, title substring, or 1-based index; omit for active" }),
      ),
      text: Type.Optional(Type.String({ description: "send: input to type into the terminal" })),
      enter: Type.Optional(
        Type.Boolean({ description: "send: press Enter after the text (default true)" }),
      ),
      wait_submit_seconds: Type.Optional(
        Type.Number({
          description: "send: also observe the prompt for submission/turn start, up to N seconds",
        }),
      ),
      condition: Type.Optional(
        StringEnum(["tui-idle", "exit"] as const, {
          description: "wait: condition (default tui-idle)",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: "wait: overall cap in seconds (default 30)" }),
      ),
      screen: Type.Optional(
        Type.Boolean({
          description:
            "read: read the rendered screen instead of accumulated output — use this for TUI apps like pi",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "read: max rows (default 400)" })),
    }),

    async execute(_id, params, signal, onUpdate) {
      const runOptions: OrcaRunOptions = signal ? { signal } : {};
      try {
        // Resolve the selector up front so every action talks about the same
        // terminal even if focus changes mid-action.
        let handle: string | undefined;
        if (params.terminal !== undefined && params.terminal.trim() !== "") {
          const terminals = await listTerminals(run, runOptions);
          const selection = selectTerminal(terminals, params.terminal);
          if ("error" in selection) throw new Error(selection.error);
          handle = selection.handle;
        }

        if (params.action === "read") {
          if (params.screen) {
            const screen = await readTerminalScreen(run, handle, runOptions, params.limit);
            return textResult(screen.text, {
              ...(handle ? { terminal: handle } : {}),
              ...(screen.source ? { source: screen.source } : {}),
            });
          }
          const result = (await run(
            [
              "terminal",
              "read",
              ...(handle ? ["--terminal", handle] : []),
              "--limit",
              String(params.limit ?? 400),
            ],
            runOptions,
          )) as { terminal?: { tail?: string[]; source?: string } } | undefined;
          const tail = result?.terminal?.tail ?? [];
          const source = result?.terminal?.source;
          const header = source === "screen" || source === undefined ? "" : `[source: ${source}]\n`;
          return textResult(clipTail(header + tail.join("\n")), {
            ...(handle ? { terminal: handle } : {}),
            ...(source ? { source } : {}),
          });
        }

        if (params.action === "send") {
          if (params.text === undefined || params.text === "") {
            throw new Error("send requires `text`");
          }
          const enter = params.enter ?? true;
          const result = await run(
            [
              "terminal",
              "send",
              ...(handle ? ["--terminal", handle] : []),
              "--text",
              params.text,
              ...(enter ? ["--enter"] : []),
              ...(params.wait_submit_seconds !== undefined
                ? ["--wait-submit", String(Math.round(params.wait_submit_seconds))]
                : []),
            ],
            runOptions,
          );
          return textResult(`Sent.\n${renderResult(result)}`, handle ? { terminal: handle } : {});
        }

        // action === "wait"
        const totalMs = Math.round((params.timeout_seconds ?? 30) * 1000);
        const outcome = await waitUntilIdle({
          run,
          ...(handle !== undefined ? { handle } : {}),
          ...(params.condition !== undefined ? { condition: params.condition } : {}),
          totalMs,
          runOptions,
          onTick: (elapsedMs) => {
            onUpdate?.({
              content: [{ type: "text", text: `waiting\u2026 ${Math.round(elapsedMs / 1000)}s` }],
              details: {},
            });
          },
        });
        if (!outcome.satisfied) {
          return textResult(
            `Condition '${params.condition ?? "tui-idle"}' not met after ${Math.round(outcome.elapsedMs / 1000)}s (status: ${outcome.status ?? "unknown"}). ` +
              "The terminal is still busy or the condition never fires.",
            { satisfied: false },
          );
        }
        return textResult(`Condition met after ${Math.round(outcome.elapsedMs / 1000)}s.`, {
          satisfied: true,
        });
      } catch (error) {
        throw new Error(orcaErrorMessage(error));
      }
    },
  });
}
