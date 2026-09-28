/**
 * Live smoke test against a running Orca. Creates and closes real tabs, so
 * run it only on a machine where that is acceptable:
 *
 *   pnpm smoke
 *
 * Exercises the full stack: binary resolution, --json envelopes, terminal
 * lifecycle, browser loop, and profile validation — the paths unit tests
 * fake.
 */
import { OrcaCliError, resolveOrcaCommand, runOrca } from "../src/orca-cli.js";
import { lookupProfile, scanProfiles } from "../src/profiles.js";
import { listTerminals, waitOnce } from "../src/tools/terminal.js";
import { extractTerminalHandle } from "../src/tools/subagent.js";
import { listBrowserTabs } from "../src/tools/tabs.js";

const section = (label: string) => console.log(`\n=== ${label} ===`);
const ok = (label: string, value: unknown) => console.log(`✓ ${label}:`, value);

async function main(): Promise<void> {
  section("binary resolution");
  ok("argv prefix", resolveOrcaCommand());

  section("profile scan");
  const scan = await scanProfiles();
  ok("profile count", scan.profiles.length);
  const nonPi = scan.profiles.filter((p) => p.agent && p.agent !== "pi").map((p) => p.name);
  ok("non-pi agents", nonPi);
  const known = scan.profiles[0]?.name;
  if (!known) throw new Error("no profiles found on this machine");
  const valid = await lookupProfile(known);
  if (!valid.ok) throw new Error(`validation failed for existing profile: ${valid.error}`);
  const invalid = await lookupProfile("definitely-not-a-profile-xyz");
  if (invalid.ok) throw new Error("validation accepted an unknown profile");
  ok("validation", `${known} ok / unknown rejected`);

  section("terminal lifecycle");
  const before = await listTerminals(runOrca);
  ok("open terminals", before.length);
  // A bare shell never satisfies tui-idle (that condition tracks agent
  // status hooks), so this terminal is verified via its own output instead.
  const created = await runOrca([
    "terminal",
    "create",
    "--title",
    "pi-orca-smoke",
    "--command",
    "exec bash --norc",
  ]);
  const handle = extractTerminalHandle(created);
  if (!handle) throw new Error(`terminal create returned no handle: ${JSON.stringify(created)}`);
  ok("created", handle);
  try {
    await runOrca([
      "terminal",
      "send",
      "--terminal",
      handle,
      "--text",
      "echo SMOKE-$((40+2))",
      "--enter",
    ]);
    let marker = false;
    for (let attempt = 0; attempt < 10 && !marker; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const read = (await runOrca([
        "terminal",
        "read",
        "--terminal",
        handle,
        "--screen",
        "--limit",
        "50",
      ])) as { terminal?: { tail?: string[] } };
      marker = (read.terminal?.tail ?? []).join("\n").includes("SMOKE-42");
    }
    if (!marker) throw new Error("screen never showed SMOKE-42");
    ok("send + screen read", "SMOKE-42 visible");

    // tui-idle is agent-status-driven: verify the wait machinery against a
    // real pi terminal from the same listing.
    const agentTerminal = (await listTerminals(runOrca)).find(
      (terminal) => terminal.agentIdentity === "pi" || terminal.title?.includes("\u03c0"),
    );
    if (agentTerminal) {
      const idle = await waitOnce(runOrca, agentTerminal.handle, "tui-idle", 5_000);
      ok(`tui-idle on ${agentTerminal.handle}`, idle.satisfied);
    } else {
      console.log("- no live pi terminal found; skipping tui-idle probe");
    }
  } finally {
    await runOrca(["terminal", "close", "--terminal", handle]);
    ok("closed", handle);
  }

  section("browser loop");
  const opened = (await runOrca(["tab", "create", "--url", "https://example.com"])) as {
    browserPageId?: string;
  };
  try {
    const tabs = await listBrowserTabs(runOrca);
    ok(
      "tabs",
      tabs.map((tab) => tab.url ?? "?"),
    );
    // The initial load may complete before a --load wait begins, so poll the
    // snapshot until the page content shows up.
    let snapText = "";
    for (let attempt = 0; attempt < 10 && !snapText.includes("Example"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const snapshot = (await runOrca(["snapshot"])) as unknown;
      snapText = JSON.stringify(snapshot);
    }
    if (!snapText.includes("Example")) throw new Error("snapshot missing 'Example' heading");
    ok("snapshot", "example.com content visible");
  } finally {
    const pageId = opened?.browserPageId;
    const tabs = await listBrowserTabs(runOrca);
    const index = tabs.findIndex((tab) => (tab.browserPageId ?? tab.pageId) === pageId);
    if (index >= 0) await runOrca(["tab", "close", "--index", String(index)]);
    ok("closed tab", pageId ?? "(by index)");
  }

  section("error surfacing");
  try {
    await runOrca(["terminal", "read", "--terminal", "term_nonexistent"]);
    throw new Error("expected an error for a bogus handle");
  } catch (error) {
    if (!(error instanceof OrcaCliError)) throw error;
    ok("typed error", `${error.kind}: ${error.message.slice(0, 80)}`);
  }

  console.log("\nAll smoke checks passed.");
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});
