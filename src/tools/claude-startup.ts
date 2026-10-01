import { setTimeout as sleep } from "node:timers/promises";
import { type OrcaRunOptions, runOrca } from "../orca-cli.js";
import { readTerminalScreen, waitOnce } from "./terminal.js";

/** Arrow-key distance from the selected option to Yes in Claude's trust dialog.
 * Recognize only the workspace-trust screen, never a tool or auth prompt. */
export function claudeTrustSelection(screen: string): number | undefined {
  if (
    !/^\s*Accessing workspace:\s*$/m.test(screen) ||
    !screen.includes("Quick safety check:") ||
    !screen.includes("Enter to confirm")
  )
    return undefined;
  const options = screen
    .split("\n")
    .map((line) =>
      line.match(/^\s*(❯|›|>)?\s*(?:\d+\.\s*)?(Yes, I trust this folder|No, exit)\s*$/),
    )
    .filter((match) => match !== null);
  if (
    options.length !== 2 ||
    options.filter((match) => match[2] === "Yes, I trust this folder").length !== 1
  )
    return undefined;
  const yes = options.findIndex((match) => match[2] === "Yes, I trust this folder");
  const selected = options.findIndex((match) => match[1] !== undefined);
  if (yes === -1 || selected === -1 || options.filter((match) => match[1]).length !== 1)
    return undefined;
  return yes - selected;
}

/** Launching a Claude subagent authorizes trust for its chosen workspace.
 * Accept that specific dialog once, then require idle before delivering work.
 * Claude itself persists the decision; we never edit its global config. */
export async function waitForClaudeReady(options: {
  run: typeof runOrca;
  handle: string;
  totalMs: number;
  runOptions: OrcaRunOptions;
  notify: (text: string) => void;
}): Promise<boolean> {
  const deadline = Date.now() + options.totalMs;
  let attemptedTrust = false;
  while (Date.now() < deadline && !options.runOptions.signal?.aborted) {
    const screen = await readTerminalScreen(options.run, options.handle, options.runOptions);
    const selection = screen.source === "screen" ? claudeTrustSelection(screen.text) : undefined;
    if (selection !== undefined && !attemptedTrust) {
      attemptedTrust = true;
      options.notify("Accepting Claude workspace trust for the selected subagent workspace…");
      if (selection !== 0) {
        const receipt = (await options.run(
          [
            "terminal",
            "send",
            "--terminal",
            options.handle,
            "--text",
            selection > 0 ? "\u001b[B" : "\u001b[A",
          ],
          options.runOptions,
        )) as { send?: { accepted?: boolean } } | undefined;
        if (receipt?.send?.accepted !== true) return false;
        await sleep(150, undefined, { signal: options.runOptions.signal });
      }
      // Re-read before Enter: don't confirm No or an unrelated dialog if the
      // UI changed, or if an arrow key wasn't handled as expected.
      let confirmed = await readTerminalScreen(options.run, options.handle, options.runOptions);
      while (
        confirmed.source === "screen" &&
        claudeTrustSelection(confirmed.text) !== undefined &&
        claudeTrustSelection(confirmed.text) !== 0 &&
        Date.now() < deadline &&
        !options.runOptions.signal?.aborted
      ) {
        await sleep(150, undefined, { signal: options.runOptions.signal });
        confirmed = await readTerminalScreen(options.run, options.handle, options.runOptions);
      }
      if (confirmed.source !== "screen" || claudeTrustSelection(confirmed.text) !== 0) return false;
      if (options.runOptions.signal?.aborted || Date.now() >= deadline) return false;
      const receipt = (await options.run(
        ["terminal", "send", "--terminal", options.handle, "--enter"],
        options.runOptions,
      )) as { send?: { accepted?: boolean } } | undefined;
      if (receipt?.send?.accepted !== true) return false;
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || options.runOptions.signal?.aborted) return false;
    const probe = await waitOnce(
      options.run,
      options.handle,
      "tui-idle",
      Math.min(1_000, remainingMs),
      options.runOptions,
    );
    if (selection === undefined && probe.satisfied) {
      const current = await readTerminalScreen(options.run, options.handle, options.runOptions);
      if (current.source === "screen" && claudeTrustSelection(current.text) !== undefined) continue;
      // Orca can report idle for the shell before Claude has even rendered.
      // Require the actual bypass-mode TUI, not a blank screen or auto mode.
      if (
        current.source === "screen" &&
        current.text.includes("Claude Code") &&
        current.text.includes("bypass permissions on") &&
        !current.text.includes("Accessing workspace:")
      )
        return true;
      await sleep(150, undefined, { signal: options.runOptions.signal });
    }
  }
  return false;
}
