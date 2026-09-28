/** Print what orca_subagent's TUI rows will look like (colors as tags). Run: npx jiti scripts/render-preview.ts */
import { subagentCallSegments, subagentStatusLine } from "../src/tools/subagent.js";

const fg = (c: string, t: string) => `[${c}]${t}[/${c}]`;

const calls = [
  { profile: "code-reviewer", task: "Review the diff and report findings.", wait: true },
  { profile: "code-reviewer", task: "Review the diff and report findings." },
  { profile: "builder", task: "Implement the settings page", worktree: "new" },
  {
    profile: "builder",
    task: "Fix flaky test",
    worktree: "path:/repo/wt",
    wait: true,
    timeout_seconds: 90,
  },
];
for (const c of calls) {
  console.log(
    "CALL   " +
      subagentCallSegments(c)
        .map((s) => fg(s.color, s.text))
        .join(" "),
  );
}

const results = [
  { status: "completed", elapsedSeconds: 12, terminal: "term_abc" },
  { status: "started", terminal: "term_abc" },
  { status: "still-running", elapsedSeconds: 600, terminal: "term_abc" },
  { status: "aborted", terminal: "term_abc" },
  { status: "not-started", terminal: "term_abc" },
  { status: "send-failed", terminal: "term_abc" },
  { status: "send-unverified", terminal: "term_abc" },
];
for (const r of results) {
  const s = subagentStatusLine(r);
  const handle = r.terminal ? fg("muted", ` · ${r.terminal}`) : "";
  console.log("RESULT " + fg(s.color, `${s.symbol} ${s.text}`) + handle);
}
