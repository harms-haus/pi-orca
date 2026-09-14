import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runOrca } from "../orca-cli.js";
import { orcaErrorMessage, renderResult, textResult } from "../util.js";
import { listTerminals, selectTerminal } from "./terminal.js";

/**
 * Tab-surface management for Orca: list, switch to, or close terminal and
 * browser tabs. Interaction with a terminal's contents belongs to
 * orca_terminal; page interaction to orca_browser.
 */

export interface OrcaBrowserTab {
  browserPageId?: string;
  pageId?: string;
  url?: string;
  title?: string;
  worktreeId?: string;
  isActive?: boolean;
}

export interface OrcaTabsDeps {
  runOrca?: typeof runOrca;
}

export async function listBrowserTabs(
  run: typeof runOrca,
  options?: Parameters<typeof runOrca>[1],
): Promise<OrcaBrowserTab[]> {
  const result = (await run(["tab", "list"], options)) as { tabs?: OrcaBrowserTab[] } | undefined;
  return result?.tabs ?? [];
}

function tabId(tab: OrcaBrowserTab): string {
  return tab.browserPageId ?? tab.pageId ?? "(unknown page id)";
}

function formatTerminals(
  terminals: readonly {
    handle: string;
    title?: string;
    worktreePath?: string;
    orphaned?: boolean;
    agentIdentity?: string;
  }[],
): string {
  if (terminals.length === 0) return "No open terminals.";
  const lines = terminals.map((terminal, index) => {
    const flags = [terminal.orphaned ? "orphaned" : undefined, terminal.agentIdentity]
      .filter(Boolean)
      .join(", ");
    return `${index + 1}. ${terminal.handle}${flags ? ` [${flags}]` : ""} — ${terminal.title ?? "(untitled)"}${terminal.worktreePath ? ` — ${terminal.worktreePath}` : ""}`;
  });
  return `Open terminals (use the handle, or this 1-based index, as the selector):\n${lines.join("\n")}`;
}

function formatBrowserTabs(tabs: readonly OrcaBrowserTab[]): string {
  if (tabs.length === 0) return "No open browser tabs.";
  const lines = tabs.map((tab, index) => {
    const active = tab.isActive === true ? " [active]" : "";
    return `${index}. ${tabId(tab)}${active} — ${tab.title ?? "(untitled)"} — ${tab.url ?? "(no url)"}`;
  });
  return `Open browser tabs (indexes are 0-based, matching the Orca CLI; use the index or page id for switch/close):\n${lines.join("\n")}`;
}

export function registerOrcaTabsTool(pi: ExtensionAPI, deps: OrcaTabsDeps = {}): void {
  const run = deps.runOrca ?? runOrca;

  pi.registerTool({
    name: "orca_tabs",
    label: "Orca Tabs",
    description:
      "List, switch to, or close Orca IDE tabs — both terminal tabs and embedded-browser tabs. " +
      "Terminals are addressed by handle or 1-based index; browser tabs by page id or 0-based index. " +
      "Switching makes a tab active in the IDE; it does not stream its contents (use orca_terminal " +
      "for terminal output, orca_browser for pages).",
    promptSnippet: "List/switch/close Orca terminal and browser tabs",
    promptGuidelines: [
      "Use orca_tabs action=list before switching or closing tabs you have not seen listed this turn.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["terminal", "browser"] as const),
      action: StringEnum(["list", "switch", "close"] as const),
      target: Type.Optional(
        Type.String({
          description:
            "terminal: handle / title substring / 1-based index. browser: page id or 0-based index.",
        }),
      ),
      worktree: Type.Optional(
        Type.String({ description: "browser: Orca worktree selector (default: active)" }),
      ),
    }),

    async execute(_id, params, signal) {
      const runOptions = signal ? { signal } : {};
      try {
        if (params.kind === "terminal") {
          if (params.action === "list") {
            return textResult(formatTerminals(await listTerminals(run, runOptions)));
          }
          if (params.target === undefined || params.target.trim() === "") {
            throw new Error(
              `${params.action} requires \`target\` (handle, title, or index); call action=list first`,
            );
          }
          const terminals = await listTerminals(run, runOptions);
          const selection = selectTerminal(terminals, params.target);
          if ("error" in selection) throw new Error(selection.error);
          const resolved = selection.handle;
          if (!resolved) {
            throw new Error(
              `Terminal '${params.target}' not found; call action=list to see open terminals.`,
            );
          }
          const result = await run(["terminal", params.action, "--terminal", resolved], runOptions);
          return textResult(
            `${params.action === "switch" ? "Switched to" : "Closed"} terminal ${resolved}.\n${renderResult(result)}`,
            { terminal: resolved },
          );
        }

        // kind === "browser"
        const worktreeArgs = params.worktree !== undefined ? ["--worktree", params.worktree] : [];
        if (params.action === "list") {
          return textResult(formatBrowserTabs(await listBrowserTabs(run, runOptions)));
        }
        if (params.target === undefined || params.target.trim() === "") {
          throw new Error(
            `${params.action} requires \`target\` (page id or index); call action=list first`,
          );
        }
        const needle = params.target.trim();
        const tabs = await listBrowserTabs(run, runOptions);
        const byPage = tabs.find((tab) => tabId(tab) === needle);
        if (byPage) {
          const index = tabs.indexOf(byPage);
          if (params.action === "switch") {
            const result = await run(
              ["tab", "switch", "--page", tabId(byPage), ...worktreeArgs],
              runOptions,
            );
            return textResult(
              `Switched to browser tab ${tabId(byPage)}.\n${renderResult(result)}`,
              {
                page: tabId(byPage),
              },
            );
          }
          await run(["tab", "close", "--index", String(index), ...worktreeArgs], runOptions);
          return textResult(`Closed browser tab ${tabId(byPage)}.`, { page: tabId(byPage) });
        }
        if (!/^\d+$/.test(needle)) {
          throw new Error(
            `No browser tab has page id '${needle}'; call action=list to see open tabs.`,
          );
        }
        const index = Number.parseInt(needle, 10);
        if (index < 0 || index >= tabs.length) {
          throw new Error(
            `Browser tab index ${index} is out of range; the listing has ${tabs.length}.`,
          );
        }
        if (params.action === "switch") {
          await run(["tab", "switch", "--index", String(index), ...worktreeArgs], runOptions);
          return textResult(`Switched to browser tab ${index}.`, { index });
        }
        await run(["tab", "close", "--index", String(index), ...worktreeArgs], runOptions);
        return textResult(`Closed browser tab ${index}.`, { index });
      } catch (error) {
        throw new Error(orcaErrorMessage(error));
      }
    },
  });
}
