import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runOrca, type OrcaRunOptions } from "../orca-cli.js";
import { validateProfileName } from "../profiles.js";
import { orcaErrorMessage, renderResult, slugify } from "../util.js";
import { readTerminalScreen, waitOnce, waitUntilIdle } from "./terminal.js";

/**
 * Spawn a profile-configured pi subagent in a visible Orca terminal tab.
 * The child runs `pi --agent-profile <profile>`, so any valid profile name
 * works — including subagent-style profiles without agentProfile:true, which
 * are selectable by exact name but never appear in /agent.
 */

const READY_TIMEOUT_MS = 60_000;
const READY_RETRY_MS = 120_000;
const DEFAULT_TASK_TIMEOUT_S = 600;
const POLL_SLICE_MS = 3_000;
const SUBMIT_DELAY_MS = 600;
const OUTPUT_ROWS = 400;

export interface OrcaSubagentDeps {
  runOrca?: typeof runOrca;
  validateProfile?: typeof validateProfileName;
  /** Readiness probe timeouts; the defaults (60s, then 120s) suit real runs. */
  readinessTimeoutsMs?: { first: number; retry: number };
  /** Turn-start detection after send: N tui-idle probes that must time out. */
  sendProbe?: { slices: number; sliceMs: number };
}

const WORKTREE_SELECTOR =
  /^(active|current|id:\S+|path:\S+|name:\S+|branch:\S+|identity:\S+|issue:\d+|folder:\S+|worktree:\S+)$/;

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
  const validate = deps.validateProfile ?? validateProfileName;
  const signal = deps.signal;
  const runOptions: OrcaRunOptions = signal ? { signal } : {};
  const notify = (text: string) => deps.onUpdate?.(text);

  // 1. Validate the profile name before anything visible happens: an unknown
  //    name would launch a child that warns and continues with no profile.
  const validation = await validate(params.profile);
  if (!validation.ok) throw new Error(validation.error ?? `Unknown profile '${params.profile}'`);

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

  // 3. Create the terminal running the profiled pi.
  const title = params.title ?? `${params.profile}:${slugify(params.task)}`;
  const command = `pi --agent-profile '${params.profile.replace(/'/g, `'\\''`)}'`;
  notify(`Starting pi --agent-profile ${params.profile} in ${worktreeNote}…`);
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
    title,
    worktree: worktreeNote,
  };

  // 4. Wait for pi to reach idle readiness before sending anything.
  let ready = false;
  const readiness = deps.readinessTimeoutsMs ?? { first: READY_TIMEOUT_MS, retry: READY_RETRY_MS };
  for (const timeoutMs of [readiness.first, readiness.retry]) {
    const probe = await waitOnce(run, handle, "tui-idle", timeoutMs, runOptions);
    if (probe.satisfied) {
      ready = true;
      break;
    }
    notify(`pi has not reached idle readiness yet (${Math.round(timeoutMs / 1000)}s elapsed)…`);
  }
  if (!ready) {
    return {
      text:
        `Terminal ${handle} (${title}) started, but pi did not become ready within ` +
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

  // 5. Send the task. Custom --command terminals report the prompt as
  //    accepted with observation "unsupported" (delivery observation is
  //    only available to Orca-managed agents), so turn start is confirmed
  //    by watching the terminal go busy instead of trusting the receipt.
  notify("Sending task\u2026");
  // Two-step delivery: pi's editor treats a fast text+Enter burst as one
  // paste and swallows the submit, so the Enter goes separately.
  const receipt = (await run(
    ["terminal", "send", "--terminal", handle, "--text", params.task],
    runOptions,
  )) as { send?: { accepted?: boolean } } | undefined;
  if (receipt?.send?.accepted !== true) {
    return {
      text: `Terminal ${handle} did not accept the task input.\n${renderResult(receipt)}`,
      details: { ...details, status: "send-failed" },
    };
  }
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
  await run(["terminal", "send", "--terminal", handle, "--enter"], runOptions);
  // A late-settling paste can swallow the first Enter, so idle probes are
  // followed by lone Enter retries (an Enter on an empty editor submits
  // nothing) until the agent goes busy or the probe budget runs out.
  const probe = deps.sendProbe ?? { slices: 20, sliceMs: 2_000 };
  let turnStarted = false;
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
  if (!turnStarted) {
    const { text: output } = await readTerminalScreen(run, handle, runOptions, OUTPUT_ROWS);
    return {
      text:
        `Task was delivered to terminal ${handle} and accepted, but the agent ` +
        "never went busy. Check the tab in Orca (it may need manual input) and " +
        "send the task manually with orca_terminal action=send if needed.\n" +
        `--- output (screen) ---\n${output}`,
      details: { ...details, status: "send-unverified" },
    };
  }

  // 6. Optionally wait for completion, then read the screen.
  if (!params.wait) {
    return {
      text:
        `Subagent '${params.profile}' started in terminal ${handle} (${worktreeNote}). ` +
        "Monitor it with orca_terminal (read with screen:true; wait with condition tui-idle), " +
        "or send follow-ups to the same terminal.",
      details: { ...details, status: "started" },
    };
  }

  const totalMs = Math.round((params.timeout_seconds ?? DEFAULT_TASK_TIMEOUT_S) * 1000);
  const outcome = await waitUntilIdle({
    run,
    handle,
    totalMs,
    sliceMs: POLL_SLICE_MS,
    runOptions,
    onTick: (elapsedMs) => {
      notify(`subagent running… ${Math.round(elapsedMs / 1000)}s`);
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
      `Subagent '${params.profile}' is still running after ${elapsedS}s` +
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
      "Delegate a task to a pi subagent that runs visibly in an Orca IDE terminal tab, launched as " +
      "`pi --agent-profile <profile>`. Any valid profile name works, including subagent profiles " +
      "(agentProfile absent) that never appear in /agent. Optionally waits for completion and " +
      "returns the subagent's screen output. The child keeps running in Orca regardless.",
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
          description: "Wait for the subagent to go idle and return its output (default false)",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: "wait: give up after N seconds (default 600)" }),
      ),
    }),

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
