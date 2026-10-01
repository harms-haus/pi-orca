import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runOrca, type OrcaRunOptions } from "../orca-cli.js";
import { lookupProfile, type ResolvedProfile, type ThinkingLevel } from "../profiles.js";
import { clipTail, orcaErrorMessage, renderResult, slugify } from "../util.js";
import { readTerminalScreen, waitOnce, waitUntilIdle } from "./terminal.js";
import { waitForClaudeReady } from "./claude-startup.js";

/**
 * Spawn a profile-configured subagent in a visible Orca terminal tab. The
 * profile frontmatter's optional `agent` field selects the CLI client that
 * runs it: `pi` (default) launches `pi --agent-profile <profile>`, while
 * `codex` and `claude` launch those CLIs with the profile body delivered as
 * claude's --append-system-prompt or prepended to codex's first message.
 */

const READY_TIMEOUT_MS = 60_000;
const READY_RETRY_MS = 120_000;
const CODEX_START_DELAY_MS = 15_000;
const DEFAULT_TASK_TIMEOUT_S = 600;
const POLL_SLICE_MS = 3_000;
const SUBMIT_DELAY_MS = 600;
const OUTPUT_ROWS = 400;

export interface OrcaSubagentDeps {
  runOrca?: typeof runOrca;
  lookupProfile?: typeof lookupProfile;
  /** Readiness probe timeouts; the defaults (60s, then 120s) suit real runs. */
  readinessTimeoutsMs?: { first: number; retry: number };
  /** Codex settle delay before sending: fresh codex never satisfies tui-idle. */
  codexStartDelayMs?: number;
  /** Codex completion watch: output-quiet poll and quiet thresholds. */
  codexQuietPoll?: { pollMs: number; quietMs: number };
  /** Turn-start detection after send: N tui-idle probes that must time out. */
  sendProbe?: { slices: number; sliceMs: number };
}

/** Quote a value for the shell string passed to `terminal create --command`. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Map a profile thinkingLevel onto claude's --effort scale. Claude has no
 * off/minimal, so those clamp to low rather than letting claude default to a
 * higher effort than the profile asked for. */
export function claudeEffort(level: ThinkingLevel): string {
  return level === "off" || level === "minimal" ? "low" : level;
}

/** Map a profile thinkingLevel onto codex's model_reasoning_effort scale,
 * which shares every level except off, spelled none. */
export function codexReasoningEffort(level: ThinkingLevel): string {
  return level === "off" ? "none" : level;
}

/** The command string that launches the profile's agent in an Orca terminal. */
export function launchCommand(profile: ResolvedProfile): string {
  switch (profile.agent) {
    case "codex":
      return [
        "codex",
        profile.model ? `--model ${shq(profile.model)}` : undefined,
        profile.thinkingLevel
          ? `-c model_reasoning_effort=${codexReasoningEffort(profile.thinkingLevel)}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "claude":
      return [
        "claude",
        "--dangerously-skip-permissions",
        profile.model ? `--model ${shq(profile.model)}` : undefined,
        profile.thinkingLevel ? `--effort ${claudeEffort(profile.thinkingLevel)}` : undefined,
        `--append-system-prompt ${shq(profile.body)}`,
      ]
        .filter(Boolean)
        .join(" ");
    default:
      return `pi --agent-profile ${shq(profile.name)}`;
  }
}

/** The message sent as the subagent's task; codex has no system-prompt flag,
 * so its profile body rides along as the preamble. */
export function composeTask(profile: ResolvedProfile, task: string): string {
  if (profile.agent === "codex" && profile.body) {
    return `${profile.body}\n\n---\n\n${task}`;
  }
  return task;
}

const CODEX_QUIET_POLL_MS = 2_000;
// Quiet floor: high enough that codex's continuously-ticking working render
// never looks quiet mid-turn, at the cost of that much latency per completion.
const CODEX_QUIET_MS = 8_000;

interface TerminalShowResult {
  terminal?: { lastOutputAt?: number };
}

/** Current output timestamp of a terminal, or -1 when unavailable. */
async function outputStamp(
  run: typeof runOrca,
  handle: string,
  runOptions: OrcaRunOptions,
): Promise<number> {
  const show = (await run(["terminal", "show", "--terminal", handle], runOptions)) as
    | TerminalShowResult
    | undefined;
  return show?.terminal?.lastOutputAt ?? -1;
}

/** Codex completion watch: satisfied once output has flowed since the send
 * and then gone quiet — codex streams while working and freezes at rest, so
 * quiet marks the finished turn (its tui-idle never reports at rest). */
export async function waitForOutputQuiet(options: {
  run: typeof runOrca;
  handle: string;
  totalMs: number;
  baseline: number;
  runOptions?: OrcaRunOptions;
  poll?: { pollMs: number; quietMs: number };
  onTick?: (elapsedMs: number) => void;
}): Promise<{ satisfied: boolean; elapsedMs: number }> {
  const { pollMs, quietMs } = options.poll ?? {
    pollMs: CODEX_QUIET_POLL_MS,
    quietMs: CODEX_QUIET_MS,
  };
  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const now = Date.now();
    options.onTick?.(now - startedAt);
    if (options.runOptions?.signal?.aborted || now - startedAt >= options.totalMs) {
      return { satisfied: false, elapsedMs: now - startedAt };
    }
    const stamp = await outputStamp(options.run, options.handle, options.runOptions ?? {});
    if (stamp > options.baseline && now - stamp >= quietMs) {
      return { satisfied: true, elapsedMs: now - startedAt };
    }
  }
}

const WORKTREE_SELECTOR =
  /^(active|current|id:\S+|path:\S+|name:\S+|branch:\S+|identity:\S+|issue:\d+|folder:\S+|worktree:\S+)$/;

/** Renderable view of orca_subagent args (they stream in while the call is typed). */
export interface SubagentCallArgs {
  profile?: string;
  task?: string;
  title?: string;
  worktree?: string;
  wait?: boolean;
  timeout_seconds?: number;
}

export interface CallSegment {
  text: string;
  color: ThemeColor;
  bold?: boolean;
}

/** Header line for the tool-call row: profile, tab label, worktree, blocking mode. */
export function subagentCallSegments(args: SubagentCallArgs): CallSegment[] {
  const segments: CallSegment[] = [{ text: "subagent ", color: "toolTitle", bold: true }];
  if (args.profile) segments.push({ text: args.profile, color: "accent" });
  const label = args.title ?? args.task;
  if (label) segments.push({ text: `"${slugify(label, 32)}"`, color: "dim" });
  if (args.worktree === "new") segments.push({ text: "new worktree", color: "muted" });
  else if (args.worktree && args.worktree !== "active")
    segments.push({ text: `worktree ${args.worktree}`, color: "muted" });
  if (args.wait) {
    const budget = args.timeout_seconds ?? DEFAULT_TASK_TIMEOUT_S;
    segments.push({ text: `⏳ blocking · waits up to ${budget}s`, color: "warning" });
  } else {
    segments.push({ text: "async", color: "dim" });
  }
  return segments;
}

export interface SubagentStatus {
  symbol: string;
  color: ThemeColor;
  text: string;
}

/** One-line outcome summary from a runSubagent details record. */
export function subagentStatusLine(details: Record<string, unknown>): SubagentStatus {
  const status = typeof details.status === "string" ? details.status : "";
  const elapsed =
    typeof details.elapsedSeconds === "number" ? `${details.elapsedSeconds}s` : undefined;
  switch (status) {
    case "completed":
      return { symbol: "✓", color: "success", text: `finished after ${elapsed ?? "—"}` };
    case "started":
      return {
        symbol: "▶",
        color: "accent",
        text: "running in background — poll with orca_terminal (wait, then read screen:true)",
      };
    case "still-running":
      return {
        symbol: "⏳",
        color: "warning",
        text: `still running after ${elapsed ?? "timeout"} — poll with orca_terminal or keep waiting`,
      };
    case "aborted":
      return {
        symbol: "⏹",
        color: "warning",
        text: "call aborted — the child keeps running in Orca",
      };
    case "aborted-before-send":
      return {
        symbol: "⏹",
        color: "warning",
        text: "call aborted before the task was sent — nothing was delivered",
      };
    case "not-started":
      return {
        symbol: "✗",
        color: "error",
        text: "the agent never became ready — check the tab (auth?) and send the task manually",
      };
    case "send-failed":
      return {
        symbol: "✗",
        color: "error",
        text: "task input was not accepted — send it manually with orca_terminal action=send",
      };
    case "send-unverified":
      return {
        symbol: "⚠",
        color: "warning",
        text: "delivered but the turn start was not observed — check the tab in Orca",
      };
    default:
      return { symbol: "•", color: "muted", text: status || "done" };
  }
}

/** Secondary lines for the expanded result view. */
export function subagentDetailLines(details: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof details.title === "string") lines.push(`title: ${details.title}`);
  if (typeof details.profile === "string") lines.push(`profile: ${details.profile}`);
  if (typeof details.agent === "string" && details.agent !== "pi")
    lines.push(`agent: ${details.agent}`);
  if (typeof details.worktree === "string") lines.push(`worktree: ${details.worktree}`);
  if (typeof details.elapsedSeconds === "number") lines.push(`elapsed: ${details.elapsedSeconds}s`);
  return lines;
}

const OUTPUT_MARKER = "--- output (screen) ---";

/** The screen-output section of a result body, for the expanded view. */
export function subagentOutputSection(body: string): string | undefined {
  const index = body.indexOf(OUTPUT_MARKER);
  if (index === -1) return undefined;
  return clipTail(body.slice(index + OUTPUT_MARKER.length).trimStart(), 4_000);
}

/** Pick a worktree selector out of a `worktree create` result, defensively. */
export function resolveWorktreeSelector(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const worktree = (record.worktree ?? record) as Record<string, unknown>;
  if (typeof worktree.worktreeId === "string" && worktree.worktreeId) {
    return `id:${worktree.worktreeId}`;
  }
  if (typeof worktree.path === "string" && worktree.path) return `path:${worktree.path}`;
  return undefined;
}

/** Extract the agent terminal handle from a `terminal create` result. */
export function extractTerminalHandle(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ["startupTerminal", "terminal"]) {
    const nested = record[key];
    if (typeof nested === "object" && nested !== null) {
      const handle = (nested as Record<string, unknown>).handle;
      if (typeof handle === "string" && handle) return handle;
    }
  }
  if (typeof record.handle === "string" && record.handle) return record.handle;
  return undefined;
}

interface SendReceipt {
  send?: { accepted?: boolean; prompt?: { stages?: string[] } };
}

export async function runSubagent(
  params: {
    profile: string;
    task: string;
    title?: string;
    worktree?: string;
    wait?: boolean;
    timeout_seconds?: number;
  },
  deps: OrcaSubagentDeps & { signal?: AbortSignal; onUpdate?: (text: string) => void },
): Promise<{ text: string; details: Record<string, unknown> }> {
  const run = deps.runOrca ?? runOrca;
  const lookup = deps.lookupProfile ?? lookupProfile;
  const signal = deps.signal;
  const runOptions: OrcaRunOptions = signal ? { signal } : {};
  const notify = (text: string) => deps.onUpdate?.(text);

  // 1. Resolve the profile before anything visible happens: an unknown name
  //    would launch a child that warns and continues with no profile, and the
  //    `agent` frontmatter decides which CLI to launch.
  const found = await lookup(params.profile);
  if (!found.ok || !found.profile)
    throw new Error(found.error ?? `Unknown profile '${params.profile}'`);
  const profile = found.profile;
  const client = profile.agent === "pi" ? `pi --agent-profile ${profile.name}` : profile.agent;
  const message = composeTask(profile, params.task);

  // 2. Resolve the worktree.
  let worktreeArgs: string[] = [];
  let worktreeNote = "active worktree";
  if (params.worktree !== undefined && params.worktree !== "") {
    if (params.worktree === "new") {
      const name = slugify(`${params.profile}-${params.title ?? params.task}`);
      notify(`Creating worktree '${name}'…`);
      const created = await run(["worktree", "create", "--name", name], runOptions);
      const selector = resolveWorktreeSelector(created);
      if (!selector) {
        throw new Error(
          `Worktree '${name}' was created but no selector was returned; find it with orca_tabs and pass worktree explicitly.\n${renderResult(created)}`,
        );
      }
      worktreeArgs = ["--worktree", selector];
      worktreeNote = `new worktree (${selector})`;
    } else {
      if (!WORKTREE_SELECTOR.test(params.worktree)) {
        throw new Error(
          `Invalid worktree selector '${params.worktree}'. Use "new", "active", or an Orca selector like path:/repo or id:<repo-id>::<path>.`,
        );
      }
      worktreeArgs = ["--worktree", params.worktree];
      worktreeNote = `worktree ${params.worktree}`;
    }
  }

  // 3. Create the terminal running the profiled agent.
  const title = params.title ?? `${params.profile}:${slugify(params.task)}`;
  const command = launchCommand(profile);
  notify(`Starting ${client} in ${worktreeNote}…`);
  const created = (await run(
    ["terminal", "create", ...worktreeArgs, "--title", title, "--command", command],
    runOptions,
  )) as unknown;
  const handle = extractTerminalHandle(created);
  if (!handle) {
    throw new Error(`Terminal was created but no handle was returned.\n${renderResult(created)}`);
  }
  const details: Record<string, unknown> = {
    terminal: handle,
    profile: params.profile,
    agent: profile.agent,
    title,
    worktree: worktreeNote,
  };

  // 4. Wait for the agent to reach idle readiness before sending anything.
  //    Codex is the exception: a freshly launched codex TUI never satisfies
  //    tui-idle until its first turn completes, so its readiness gate is a
  //    settle delay instead of a probe (verified against codex 0.158).
  let ready = false;
  const readiness = deps.readinessTimeoutsMs ?? { first: READY_TIMEOUT_MS, retry: READY_RETRY_MS };
  if (profile.agent === "codex") {
    const delayMs = deps.codexStartDelayMs ?? CODEX_START_DELAY_MS;
    notify("Giving codex a moment to start…");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    ready = true;
  } else if (profile.agent === "claude") {
    notify("Waiting for claude to become ready…");
    ready = await waitForClaudeReady({
      run,
      handle,
      totalMs: readiness.first + readiness.retry,
      runOptions,
      notify,
    });
  } else {
    notify(`Waiting for ${profile.agent} to become ready…`);
    for (const timeoutMs of [readiness.first, readiness.retry]) {
      const probe = await waitOnce(run, handle, "tui-idle", timeoutMs, runOptions);
      if (probe.satisfied) {
        ready = true;
        break;
      }
      notify(
        `${profile.agent} has not reached idle readiness yet (${Math.round(timeoutMs / 1000)}s elapsed)…`,
      );
    }
  }
  if (!ready) {
    return {
      text:
        `Terminal ${handle} (${title}) started, but ${profile.agent} did not become ready within ` +
        `${Math.round((readiness.first + readiness.retry) / 1000)}s. Nothing was sent. ` +
        "Check the tab in Orca (it may be waiting on authentication) and send the task manually " +
        "with orca_terminal action=send.",
      details: { ...details, status: "not-started" },
    };
  }

  if (signal?.aborted) {
    return {
      text: `Terminal ${handle} started but the call was aborted before the task was sent.`,
      details: { ...details, status: "aborted-before-send" },
    };
  }

  // 5. Send the task. Delivery differs per client: pi's editor treats a fast
  //    text+Enter burst as one paste and swallows the submit, so pi and
  //    claude send text then Enter separately, with idle probes confirming
  //    the turn. Codex sends text+Enter in one call with --wait-submit, which
  //    observes the turn start natively (Orca tracks codex turns through the
  //    send path even though its tui-idle never reports at rest).
  notify("Sending task…");
  const codex = profile.agent === "codex";
  let quietBaseline = -1;
  let receipt: SendReceipt | undefined;
  if (codex) {
    quietBaseline = await outputStamp(run, handle, runOptions);
    receipt = (await run(
      [
        "terminal",
        "send",
        "--terminal",
        handle,
        "--text",
        message,
        "--enter",
        "--wait-submit",
        "30",
      ],
      { ...runOptions, timeoutMs: 45_000 },
    )) as SendReceipt | undefined;
  } else {
    receipt = (await run(
      ["terminal", "send", "--terminal", handle, "--text", message],
      runOptions,
    )) as SendReceipt | undefined;
  }
  if (receipt?.send?.accepted !== true) {
    return {
      text: `Terminal ${handle} did not accept the task input.\n${renderResult(receipt)}`,
      details: { ...details, status: "send-failed" },
    };
  }
  let turnStarted: boolean;
  if (codex) {
    turnStarted = receipt?.send?.prompt?.stages?.includes("turn_started") === true;
  } else {
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    await run(["terminal", "send", "--terminal", handle, "--enter"], runOptions);
    // A late-settling paste can swallow the first Enter, so idle probes are
    // followed by lone Enter retries (an Enter on an empty editor submits
    // nothing) until the agent goes busy or the probe budget runs out.
    notify("Confirming the turn started…");
    const probe = deps.sendProbe ?? { slices: 20, sliceMs: 2_000 };
    turnStarted = false;
    let probedMs = 0;
    let enterRetries = 0;
    for (;;) {
      if (signal?.aborted) break;
      const idle = await waitOnce(run, handle, "tui-idle", probe.sliceMs, runOptions);
      if (!idle.satisfied) {
        turnStarted = true;
        break;
      }
      probedMs += probe.sliceMs;
      if (probedMs >= probe.slices * probe.sliceMs) break;
      if (enterRetries < 10) {
        await run(["terminal", "send", "--terminal", handle, "--enter"], runOptions);
        enterRetries++;
      }
    }
  }
  if (!turnStarted) {
    const { text: output } = await readTerminalScreen(run, handle, runOptions, OUTPUT_ROWS);
    return {
      text:
        `Task was delivered to terminal ${handle} and accepted, but the turn start was not ` +
        "observed (the agent may have finished before the first probe). Check the tab in Orca " +
        "and send again with orca_terminal action=send if needed.\n" +
        `--- output (screen) ---\n${output}`,
      details: { ...details, status: "send-unverified" },
    };
  }

  // 6. Optionally wait for completion, then read the screen.
  if (!params.wait) {
    return {
      text:
        `Subagent '${params.profile}' (${profile.agent}) started in terminal ${handle} (${worktreeNote}). ` +
        "Monitor it with orca_terminal (read with screen:true; wait with condition tui-idle), " +
        "or send follow-ups to the same terminal.",
      details: { ...details, status: "started" },
    };
  }

  const totalMs = Math.round((params.timeout_seconds ?? DEFAULT_TASK_TIMEOUT_S) * 1000);
  const budgetS = Math.round(totalMs / 1000);
  // Codex completion is the output-quiet watch (its tui-idle never reports at
  // rest); pi and claude poll tui-idle in short slices so progress streams.
  const outcome =
    profile.agent === "codex"
      ? await waitForOutputQuiet({
          run,
          handle,
          totalMs,
          baseline: quietBaseline,
          runOptions,
          ...(deps.codexQuietPoll ? { poll: deps.codexQuietPoll } : {}),
          onTick: (elapsedMs) => {
            notify(`Running… ${Math.round(elapsedMs / 1000)}s of ${budgetS}s`);
          },
        })
      : await waitUntilIdle({
          run,
          handle,
          totalMs,
          sliceMs: POLL_SLICE_MS,
          runOptions,
          onTick: (elapsedMs) => {
            notify(`Running… ${Math.round(elapsedMs / 1000)}s of ${budgetS}s`);
          },
        });
  const idle = outcome.satisfied;
  const elapsedS = Math.round(outcome.elapsedMs / 1000);
  const { text: output } = await readTerminalScreen(run, handle, runOptions, OUTPUT_ROWS);
  if (idle) {
    return {
      text:
        `Subagent '${params.profile}' finished after ${elapsedS}s. Terminal ${handle}.\n` +
        `--- output (screen) ---\n${output}`,
      details: { ...details, status: "completed", elapsedSeconds: elapsedS },
    };
  }
  return {
    text:
      `Subagent '${params.profile}' is still running after ${elapsedS}s (wait timeout ${budgetS}s)` +
      `${signal?.aborted ? " (call aborted)" : ""}. Terminal ${handle}. Current screen:\n` +
      `--- output (screen) ---\n${output}`,
    details: { ...details, status: signal?.aborted ? "aborted" : "still-running" },
  };
}

export function registerOrcaSubagentTool(pi: ExtensionAPI, deps: OrcaSubagentDeps = {}): void {
  pi.registerTool({
    name: "orca_subagent",
    label: "Orca Subagent",
    description:
      "Delegate a task to a subagent that runs visibly in an Orca IDE terminal tab. The profile " +
      "frontmatter's optional `agent` field selects the CLI client: `pi` (default) runs " +
      "`pi --agent-profile <profile>`; `codex` and `claude` launch those CLIs, with the profile " +
      "body passed as claude's --append-system-prompt or prepended to codex's first message " +
      "(frontmatter `model` forwards to --model; `thinkingLevel` forwards as each CLI's " +
      "effort setting). Claude runs with --dangerously-skip-permissions and startup accepts " +
      "workspace trust for the selected workspace; use only workspaces you trust. " +
      "Any valid profile name works, including " +
      "subagent profiles (agentProfile absent) that never appear in /agent. Optionally waits for " +
      "completion and returns the subagent's screen output. The child keeps running in Orca " +
      "regardless.",
    promptSnippet: "Spawn a profile-configured pi subagent in a visible Orca terminal tab",
    promptGuidelines: [
      "Use orca_subagent to delegate bounded tasks to profile-configured subagents; pass wait:true when the next step depends on the result.",
      "After orca_subagent returns a still-running handle, poll with orca_terminal action=wait, then action=read with screen:true.",
    ],
    parameters: Type.Object({
      profile: Type.String({ description: "Profile name (frontmatter name, e.g. code-reviewer)" }),
      task: Type.String({ description: "Complete, self-contained task for the subagent" }),
      title: Type.Optional(
        Type.String({ description: "Orca tab title (default: profile:task-slug)" }),
      ),
      worktree: Type.Optional(
        Type.String({
          description:
            '"new" for a child worktree, "active" (or omit) for the current one, or an Orca selector (path:/repo, id:…, name:…)',
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "BLOCKING: wait for the subagent to go idle, then return its screen output " +
            "(default false). wait:true holds this agent's turn until the child finishes or " +
            "timeout_seconds elapses; wait:false returns immediately with the terminal handle.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: "wait: give up after N seconds (default 600)" }),
      ),
    }),

    renderCall(args, theme) {
      const text = subagentCallSegments(args as SubagentCallArgs)
        .map((segment) =>
          theme.fg(segment.color, segment.bold ? theme.bold(segment.text) : segment.text),
        )
        .join(" ");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const body = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (isPartial) {
        return new Text(theme.fg("warning", `⏳ ${body}`), 0, 0);
      }
      const details = (result.details ?? {}) as Record<string, unknown>;
      const status = subagentStatusLine(details);
      let text = theme.fg(status.color, `${status.symbol} ${status.text}`);
      if (typeof details.terminal === "string") text += theme.fg("muted", ` · ${details.terminal}`);
      if (expanded) {
        for (const line of subagentDetailLines(details)) {
          text += `\n  ${theme.fg("dim", line)}`;
        }
        const output =
          subagentOutputSection(body) ??
          (status.color === "error" ? clipTail(body, 4_000) : undefined);
        if (output) text += `\n${theme.fg("toolOutput", output)}`;
      }
      return new Text(text, 0, 0);
    },

    async execute(_id, params, signal, onUpdate) {
      try {
        const outcome = await runSubagent(params, {
          ...deps,
          ...(signal ? { signal } : {}),
          ...(onUpdate
            ? {
                onUpdate: (text: string) =>
                  onUpdate({ content: [{ type: "text", text }], details: {} }),
              }
            : {}),
        });
        return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
      } catch (error) {
        throw new Error(orcaErrorMessage(error));
      }
    },
  });
}
